# Forge Mobile Core

`@arveniq/forge-mobile-core` calls an end-user-safe Forge mobile integration gateway. It does not accept Forge Developer API keys and it deliberately models trusted context as an opaque assertion.

Provide a `credentialProvider` that obtains a short-lived, audience-bound gateway access token from your customer backend or identity provider. Generate `ContextAssertion` values only from a trusted backend after it verifies end-user authorization.
