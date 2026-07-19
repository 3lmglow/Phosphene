# Security

Phosphene is designed for a single private user and a single AI connection. Do not expose PostgreSQL
or object storage publicly, and never commit setup, session, database, or S3 secrets.

## Supported version

Security fixes are provided for the latest 1.x release.

## Reporting a vulnerability

Do not open a public issue containing secrets, proof images, or exploit details. Contact the repository
owner privately and include the affected version, reproduction steps, and impact. Remove all real
Phosphene data from the report.

## Deployment checklist

- Use unique random values for `PHOSPHENE_SETUP_TOKEN`, `SESSION_SECRET`, database credentials, and S3 credentials.
- Keep the Phosphene website behind HTTPS.
- Leave PostgreSQL and MinIO on private project networking only.
- Rotate the AI token immediately if it is copied into an untrusted client.
- Export a Phosphene backup and enable infrastructure snapshots before upgrading.
