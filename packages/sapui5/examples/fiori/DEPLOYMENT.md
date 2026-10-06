# Deploy the Fiori sample

Build and verify the app locally first. `manifest.json` declares application ID
`arveniq.forge.sample`, display title **Ask Forge AI**, and intent `#AskPingLead-chat`.
The existing semantic object stays unchanged to preserve configured target mappings;
the app, tile and assistant labels use Forge AI.

## SAP BTP / SAP Build Work Zone

1. Deploy a production gateway implementing the package's authenticated contract.
   Configure a Forge workload key/agent and a durable user/tenant conversation store.
   Verify IAS/XSUAA identities and application entitlement on that gateway.
2. Configure a BTP destination named `ForgeChatGateway` with the gateway's HTTPS
   origin. Use the authentication/identity propagation strategy appropriate to
   your backend. For an XSUAA-aware backend in the same trust domain, a destination
   with `HTML5.ForwardAuthToken: true` can propagate the token; the gateway must
   verify its signature, issuer, audience, tenant and scopes. Do not put a Forge
   Developer key in a browser-facing destination.
3. Bind/subscribe the relevant HTML5 Application Repository, Destination, XSUAA
   and SAP Build Work Zone services. The included `mta.yaml` creates the HTML5
   repository, Destination instance, and XSUAA app registration; it expects your managed app router and
   `ForgeChatGateway` destination to be configured in the consuming subaccount.
4. From this sample folder, run `npm ci`, `npm run typecheck`, `npm run build`.
   Build the MTA with your installed Cloud MTA Build Tool (`mbt build`) and deploy
   its generated `.mtar` with the Cloud Foundry MTA plugin (`cf deploy ...`). These
   deployment tools and a SAP account are not installed by the SDK.
5. Refresh/import HTML5 app content in Work Zone, assign the app to the intended
   role, and put it on the relevant space/page. Assign the `ChatUser` role template
   from `xs-security.json` through an appropriate role collection.
6. Verify `#AskPingLead-chat`, CSRF acquisition, streaming through the managed
   router, two users in the same tenant, tenant separation, cancellation and
   approval resume in the actual launchpad. Check proxy timeouts and buffering.

The component resolves the gateway URI against its manifest location, preserving
the app's runtime path. `xs-app.json` proxies only the application's gateway route.
The `Chat` scope controls application access; backend tool adapters still enforce
SAP business-object authorization.

## Existing ABAP Fiori Launchpad

1. Run `npm run build` and deploy the `dist` app (including the custom library
   resources) into a SAPUI5 ABAP repository/BSP application using your team's
   SAP Fiori tools deployment configuration and transport.
2. Create a tile and target mapping: application type SAPUI5, component ID
   `arveniq.forge.sample`, semantic object `AskPingLead`, action `chat`.
3. Assign the technical/business catalogs and appropriate roles, then add the tile
   to the intended space/page.
4. Configure an authenticated **same-origin** reverse-proxy/gateway route. The BTP
   `xs-app.json` is not an ABAP reverse-proxy configuration. Adapt the manifest
   gateway URI to the route your Web Dispatcher or integration backend exposes.
5. Verify the host UI5 runtime supports the used APIs and run the same identity,
   ownership, streaming and CSRF tests in that landscape.

The repository build is verified independently of SAP landscape configuration.
Tenant SSO, destinations, role assignments, ABAP transports and live model/tool
behavior must be validated in your deployment environment.
