import z from 'zod'

export const CredentialOfferSchema = z.object({
	credential_issuer: z.string(),
	credential_configuration_ids: z.array(z.string()),
	grants: z.object({
		"authorization_code": z.object({}).optional()
	})
})

export type CredentialOffer = z.infer<typeof CredentialOfferSchema>;