# Self-hosted Google access with a service account

A service account connects Search Console and Google Analytics without a
person's Google login. Nothing expires. Nobody has to reconnect. Removing a
teammate from your Google Workspace does not cut off your data.

Use this when one team runs OpenSEO for its own or its clients' sites. Use the
OAuth setup ([Search Console](SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md),
[Analytics](SELF_HOSTING_GOOGLE_ANALYTICS.md)) when each user should connect
their own Google account. Both can be configured at once.

## 1) Create the service account

In the [Google Cloud Console](https://console.cloud.google.com/):

1. Pick or create a project.
2. Enable the **Google Search Console API**, the **Google Analytics Admin
   API** and the **Google Analytics Data API**.
3. Open **IAM & Admin → Service Accounts → Create service account**. It needs
   no project roles.
4. Open the account, then **Keys → Add key → Create new key → JSON**.

## 2) Set the environment variable

| Variable                     | Value                                   |
| ---------------------------- | --------------------------------------- |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | The full contents of the JSON key file. |

`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are not
needed for service account access. `/api/health` reports Search Console as
`Configured (service account)`.

## 3) Grant the service account access to each site

The service account sees only what a property owner shares with it. Use the
`client_email` from the key file.

- **Search Console:** Settings → Users and permissions → Add user →
  `client_email`, permission **Restricted**. Only a property owner can add
  users.
- **Google Analytics:** Admin → Property access management → Add users →
  `client_email`, role **Viewer**.

## 4) Connect a project

Open a project's **Integrations**. The service account appears in the property
picker next to any personal Google accounts, listing every property shared
with it. Pick one.

## How it works

- OpenSEO signs a short-lived JWT with the key and exchanges it at Google's
  token endpoint for an access token. It keeps no refresh token.
- The key never reaches the browser and is never written to the database.
- The service account entry cannot be removed from the picker. To revoke
  access, remove the user from the property in Google, or delete the key in
  Google Cloud.
