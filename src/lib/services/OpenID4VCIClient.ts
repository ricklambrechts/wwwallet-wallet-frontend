import { IOpenID4VCIClient } from '../interfaces/IOpenID4VCIClient';
import { IHttpProxy } from '../interfaces/IHttpProxy';
import { ClientConfig } from '../types/ClientConfig';
import pkce from 'pkce-challenge';
import { IOpenID4VCIClientStateRepository } from '../interfaces/IOpenID4VCIClientStateRepository';
import { CredentialConfigurationSupported } from '../schemas/CredentialConfigurationSupportedSchema';
import { OpenID4VCIClientState } from '../types/OpenID4VCIClientState';
import { generateDPoP } from '../utils/dpop';
import { CredentialOfferSchema } from '../schemas/CredentialOfferSchema';
import { StorableCredential } from '../types/StorableCredential';
import * as jose from 'jose';
import { generateRandomIdentifier } from '../utils/generateRandomIdentifier';
import * as config from '../../config';

const redirectUri = config.OPENID4VCI_REDIRECT_URI as string;

export class OpenID4VCIClient implements IOpenID4VCIClient {

	constructor(private config: ClientConfig,
		private httpProxy: IHttpProxy,
		private openID4VCIClientStateRepository: IOpenID4VCIClientStateRepository,
		private generateNonceProof: (cNonce: string, audience: string, clientId: string) => Promise<{ jws: string }>,
		private storeCredential: (c: StorableCredential) => Promise<void>
	) { }

	async handleCredentialOffer(credentialOfferURL: string): Promise<{ credentialIssuer: string, selectedCredentialConfigurationId: string; issuer_state?: string }> {
		const parsedUrl = new URL(credentialOfferURL);
		let offer;
		if (parsedUrl.searchParams.get("credential_offer")) {
			offer = CredentialOfferSchema.parse(JSON.parse(parsedUrl.searchParams.get("credential_offer")));
		} else {
			try {
				let response = await this.httpProxy.get(parsedUrl.searchParams.get("credential_offer_uri"), {})
				offer = response.data;
			}
			catch (err) {
				console.error(err);
				return;
			}
		}

		if (!offer.grants.authorization_code) {
			throw new Error("Only authorization_code grant is supported");
		}

		if (offer.credential_issuer != this.config.credentialIssuerIdentifier) {
			return;
		}

		const selectedConfigurationId = offer.credential_configuration_ids[0];
		const selectedConfiguration = this.config.credentialIssuerMetadata.credential_configurations_supported[selectedConfigurationId];
		if (!selectedConfiguration) {
			throw new Error("Credential configuration not found");
		}

		let issuer_state = undefined;
		if (offer.grants?.authorization_code?.issuer_state) {
			issuer_state = offer.grants.authorization_code.issuer_state;
		}

		return { credentialIssuer: offer.credential_issuer, selectedCredentialConfigurationId: selectedConfigurationId, issuer_state };
	}

	async getAvailableCredentialConfigurations(): Promise<Record<string, CredentialConfigurationSupported>> {
		if (!this?.config?.credentialIssuerMetadata?.credential_configurations_supported) {
			throw new Error("Credential configuration supported not found")
		}
		return this.config.credentialIssuerMetadata.credential_configurations_supported
	}

	async generateAuthorizationRequest(credentialConfigurationId: string, userHandleB64u: string, issuer_state?: string): Promise<{ url: string; client_id: string; request_uri: string; }> {

		try { // attempt to get credentials using active session
			await this.requestCredentials({
				userHandleB64u,
				usingActiveAccessToken: {
					credentialConfigurationId
				}
			});
			window.location.href = '/';
			return;
		}
		catch (err) { console.error(err) }

		const { code_challenge, code_verifier } = await pkce();

		const formData = new URLSearchParams();

		const selectedCredentialConfigurationSupported = this.config.credentialIssuerMetadata.credential_configurations_supported[credentialConfigurationId];
		formData.append("scope", selectedCredentialConfigurationSupported.scope);

		formData.append("response_type", "code");

		formData.append("client_id", this.config.clientId);
		formData.append("code_challenge", code_challenge);

		formData.append("code_challenge_method", "S256");

		// the purpose of the "id" is to provide the "state" a random factor for unlinkability and to make OpenID4VCIClientState instances unique
		const state = btoa(JSON.stringify({ userHandleB64u: userHandleB64u, id: generateRandomIdentifier(12) })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
		formData.append("state", state);

		if (issuer_state) {
			formData.append("issuer_state", issuer_state);
		}

		formData.append("redirect_uri", redirectUri);
		let res;
		try {
			res = await this.httpProxy.post(this.config.authorizationServerMetadata.pushed_authorization_request_endpoint, formData.toString(), {
				'Content-Type': 'application/x-www-form-urlencoded'
			});
		}
		catch (err) {
			throw new Error("Pushed authorization request failed ", err.response.data)
		}

		const { request_uri } = res.data;
		const authorizationRequestURL = `${this.config.authorizationServerMetadata.authorization_endpoint}?request_uri=${request_uri}&client_id=${this.config.clientId}`

		console.log("State to be stored = ", state)
		await this.openID4VCIClientStateRepository.create(new OpenID4VCIClientState(userHandleB64u, state, code_verifier, credentialConfigurationId))
		return {
			url: authorizationRequestURL,
			request_uri,
			client_id: this.config.clientId,
		}
	}

	async handleAuthorizationResponse(url: string, dpopNonceHeader?: string) {
		const parsedUrl = new URL(url);

		const code = parsedUrl.searchParams.get('code');
		const state = parsedUrl.searchParams.get('state');

		if (!code) {
			throw new Error("Could not handle authorization response");
		}
		const s = await this.openID4VCIClientStateRepository.getByState(state);
		if (!s) {
			return;
		}
		await this.requestCredentials({
			userHandleB64u: s.userHandleB64U,
			dpopNonceHeader: dpopNonceHeader,
			authorizationCodeGrant: {
				authorizationResponseUrl: url,
				code: code,
				state: state,
			}
		});
	}

	private async requestCredentials(requestCredentialsParams: {
		userHandleB64u: string,
		dpopNonceHeader?: string,
		preAuthorizedCodeGrant?: {
			pre_authorized_code: string;
		},
		authorizationCodeGrant?: {
			state: string;
			authorizationResponseUrl: string;
			code: string;
		},
		usingActiveAccessToken?: {
			credentialConfigurationId: string;
		},
		refreshTokenGrant?: {
			credentialConfigurationId: string;
		}
	}) {


		if (requestCredentialsParams.usingActiveAccessToken) {
			console.log("Attempting with active access token")
			const flowState = await this.openID4VCIClientStateRepository.getByCredentialConfigurationId(requestCredentialsParams.usingActiveAccessToken.credentialConfigurationId)
			if (!flowState) {
				throw new Error("Using active access token: No flowstate");
			}

			// if c_nonce and access_token are not expired
			if (flowState.tokenResponse && Math.floor(Date.now() / 1000) < flowState.tokenResponse.data.c_nonce_expiration_timestamp && Math.floor(Date.now() / 1000) < flowState.tokenResponse.data.expiration_timestamp) {
				// attempt credential request
				if (!flowState.dpop) {
					throw new Error("Using active access token: No dpop in flowstate");
				}

				await this.credentialRequest(flowState.tokenResponse, flowState);
				return;
			}
			else {
				console.log("Using active access token: c_nonce or access_token are expired");
			}

			// if access_token is expired
			if (flowState.tokenResponse && Math.floor(Date.now() / 1000) > flowState.tokenResponse.data.expiration_timestamp) {
				// refresh token grant
				await this.requestCredentials({
					userHandleB64u: requestCredentialsParams.userHandleB64u,
					dpopNonceHeader: requestCredentialsParams.dpopNonceHeader,
					refreshTokenGrant: {
						credentialConfigurationId: requestCredentialsParams.usingActiveAccessToken.credentialConfigurationId
					}
				})
				return;
			}
			throw new Error("Couldn't hande using active access token");
		}
		// Token Request
		const tokenEndpoint = this.config.authorizationServerMetadata.token_endpoint;


		let flowState: OpenID4VCIClientState | null = null;

		if (requestCredentialsParams?.authorizationCodeGrant) {
			flowState = await this.openID4VCIClientStateRepository.getByState(requestCredentialsParams.authorizationCodeGrant.state)
		}
		else if (requestCredentialsParams?.refreshTokenGrant) {
			flowState = await this.openID4VCIClientStateRepository.getByCredentialConfigurationId(requestCredentialsParams.refreshTokenGrant.credentialConfigurationId)
		}

		if (!flowState) {
			throw new Error("No flowstate");
		}

		const { privateKey, publicKey } = await jose.generateKeyPair('ES256', { extractable: true }); // keypair for dpop if used
		const jti = generateRandomIdentifier(8);

		const [privateKeyJwk, publicKeyJwk] = await Promise.all([
			jose.exportJWK(privateKey),
			jose.exportJWK(publicKey)
		]);


		let tokenRequestHeaders = {
			'Content-Type': 'application/x-www-form-urlencoded',
		};

		if (this.config.authorizationServerMetadata.dpop_signing_alg_values_supported) {
			const dpop = await generateDPoP(
				privateKey,
				publicKeyJwk,
				jti,
				"POST",
				tokenEndpoint,
				requestCredentialsParams.dpopNonceHeader
			);
			flowState.dpop = {
				dpopAlg: 'ES256',
				dpopJti: jti,
				dpopPrivateKeyJwk: privateKeyJwk,
				dpopPublicKeyJwk: publicKeyJwk,
			}
			tokenRequestHeaders['DPoP'] = dpop;
		}


		const formData = new URLSearchParams();
		formData.append('client_id', this.config.clientId);
		if (requestCredentialsParams.authorizationCodeGrant) {
			formData.append('grant_type', 'authorization_code');
			formData.append('code', requestCredentialsParams.authorizationCodeGrant.code);
			formData.append('code_verifier', flowState.code_verifier);
		}
		else if (requestCredentialsParams.refreshTokenGrant && flowState?.tokenResponse?.data.refresh_token) {
			formData.append('grant_type', 'refresh_token');
			formData.append('refresh_token', flowState.tokenResponse.data.refresh_token);
		}
		formData.append('redirect_uri', redirectUri);

		let response;
		try {
			response = await this.httpProxy.post(tokenEndpoint, formData.toString(), tokenRequestHeaders);
		}
		catch (err) {
			console.log("failed token request")
			console.error(err);
			if (err.response.data.err.headers['dpop-nonce']) {
				requestCredentialsParams.dpopNonceHeader = err.response.data.err.headers['dpop-nonce'];
				if (requestCredentialsParams.dpopNonceHeader) {
					this.handleAuthorizationResponse(requestCredentialsParams.authorizationCodeGrant.authorizationResponseUrl, requestCredentialsParams.dpopNonceHeader);
					return;
				}
			}
		}

		try { // try to extract the response and update the OpenID4VCIClientStateRepository
			const {
				data: { access_token, c_nonce, expires_in, c_nonce_expires_in, refresh_token },
			} = response;

			flowState.tokenResponse = {
				data: {
					access_token, c_nonce, expiration_timestamp: Math.floor(Date.now() / 1000) + expires_in, c_nonce_expiration_timestamp: Math.floor(Date.now() / 1000) + c_nonce_expires_in, refresh_token
				},
				headers: { ...response.headers }
			}

			await this.openID4VCIClientStateRepository.updateState(flowState);
		}
		catch (err) {
			console.error(err);
			throw new Error("Failed to extract the response and update the OpenID4VCIClientStateRepository");
		}

		try {
			// Credential Request
			await this.credentialRequest(flowState.tokenResponse, flowState);
		}
		catch (err) {
			console.error("Error handling authrozation response ", err);
			throw new Error("Credential request failed");
		}
	}

	private async credentialRequest(response: any, flowState: OpenID4VCIClientState) {
		const {
			data: { access_token, c_nonce, expires_in, c_nonce_expires_in },
		} = response;


		const credentialEndpoint = this.config.credentialIssuerMetadata.credential_endpoint;

		const privateKey = await jose.importJWK(flowState.dpop.dpopPrivateKeyJwk, flowState.dpop.dpopAlg);

		let credentialRequestHeaders = {
			"Authorization": `Bearer ${access_token}`,
		};

		if (this.config.authorizationServerMetadata.dpop_signing_alg_values_supported) {
			const newDPoPNonce = response.headers['dpop-nonce'];
			const credentialEndpointDPoP = await generateDPoP(
				privateKey as jose.KeyLike,
				flowState.dpop.dpopPublicKeyJwk,
				flowState.dpop.dpopJti,
				"POST",
				credentialEndpoint,
				newDPoPNonce,
				access_token
			);

			credentialRequestHeaders['Authorization'] = `DPoP ${access_token}`;
			credentialRequestHeaders['dpop'] = credentialEndpointDPoP;
		}

		let jws;
		try {
			const generateProofResult = await this.generateNonceProof(c_nonce, this.config.credentialIssuerIdentifier, this.config.clientId);
			jws = generateProofResult.jws;
			console.log("proof = ", jws)
		}
		catch (err) {
			console.error(err);
			throw new Error("Failed to generate proof");
		}

		const credentialEndpointBody = {
			"proof": {
				"proof_type": "jwt",
				"jwt": jws,
			},
			"format": this.config.credentialIssuerMetadata.credential_configurations_supported[flowState.credentialConfigurationId].format,
			...this.config.credentialIssuerMetadata.credential_configurations_supported[flowState.credentialConfigurationId], // include credential_definition, vct, doctype etc.
		};

		try {
			const credentialResponse = await this.httpProxy.post(credentialEndpoint, credentialEndpointBody, credentialRequestHeaders);
			console.log("Credential response = ", credentialResponse)
			const { credential, c_nonce, c_nonce_expires_in } = credentialResponse.data;

			if (c_nonce && c_nonce_expires_in) {
				flowState.tokenResponse.data.c_nonce = c_nonce;
				flowState.tokenResponse.data.c_nonce_expiration_timestamp = Math.floor(Date.now() / 1000) + c_nonce_expires_in;
				await this.openID4VCIClientStateRepository.updateState(flowState);
			}

			await this.storeCredential({
				credentialIdentifier: generateRandomIdentifier(32),
				credential: credential,
				format: this.config.credentialIssuerMetadata.credential_configurations_supported[flowState.credentialConfigurationId].format,
				credentialConfigurationId: flowState.credentialConfigurationId,
				credentialIssuerIdentifier: this.config.credentialIssuerIdentifier,
			});
			return;
		}
		catch (err) {
			console.error("Failed to recieve credential during issuance protocol");
			console.error(err);
			throw new Error("Credential Request failed")
		}
	}
}
