# Security

Phosphene is designed for one private user and one AI connection per deployment. The supported
default production topology stores the PGlite database and private proof images on one persistent
`/data` volume. The optional distributed topology uses private PostgreSQL and S3/MinIO services.

## Supported version

Security fixes are provided for the latest 1.x release.

## Reporting a vulnerability

Do not open a public issue containing secrets, proof images, or exploit details. Contact the
repository owner privately with the affected version, reproduction steps, and impact. Remove all
real Phosphene data from the report.

## Deployment checklist

- Use unique random values of at least 24 characters for `PHOSPHENE_SETUP_TOKEN` and 32 characters
  for `SESSION_SECRET`.
- Mount a private persistent volume at `/data`; do not use an ephemeral directory.
- Keep the Phosphene website behind HTTPS.
- Do not expose the contents of `/data` through a static file server.
- If using distributed mode, keep PostgreSQL and MinIO/S3 on private networking and use unique
  database and object-storage credentials.
- Rotate the AI token immediately if it is copied into an untrusted client.
- Export a Phosphene ZIP and enable persistent-volume snapshots before upgrading.
- Treat deleting the service volume as a destructive operation: it contains both the database and
  proof images.
