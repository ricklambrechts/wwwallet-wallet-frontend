export const LocalAuthentication = () => {
	const rpId = process.env.REACT_APP_WEBAUTHN_RPID;

	const makeGetOptions = ({
		challenge,
	}: {
		challenge: Uint8Array,
	}) => {
		return {
			publicKey: {
				rpId: rpId,
				challenge: challenge,
				allowCredentials: [],
				userVerification: "required",
			},
		};
	}

	const createChallenge = async () => {
		try {
			const array = new Uint8Array(32);

			// Fill the array with cryptographically secure random values
			const challenge = window.crypto.getRandomValues(array);
			return challenge;
		}
		catch(err) {
			return null;
		}
	}
	return {
		loginWebAuthnBeginOffline: async (): Promise<{ getOptions: any }> => {
			const challenge = await createChallenge();
			const getOptions = makeGetOptions({ challenge });
			return {
				getOptions: getOptions
			}
		},
	}

}
