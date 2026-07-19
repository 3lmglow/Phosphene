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

- Optionally provide a unique `PHOSPHENE_SETUP_TOKEN` of at least 24 characters. If it is missing,
  a known placeholder, or too short, Phosphene generates a strong token, stores it with mode `0600`
  below `/data`, and prints it only while the application still needs first-time setup.
- Mount a private persistent volume at `/data`; do not use an ephemeral directory.
- Keep the Phosphene website behind HTTPS.
- Do not expose the contents of `/data` through a static file server.
- Treat deployment logs as private until first-time setup is complete because they can contain the
  automatically generated one-time Setup Token.
- If using distributed mode, keep PostgreSQL and MinIO/S3 on private networking and use unique
  database and object-storage credentials.
- Rotate the AI token immediately if it is copied into an untrusted client.
- Export a Phosphene ZIP and enable persistent-volume snapshots before upgrading.
- Treat deleting the service volume as a destructive operation: it contains both the database and
  proof images.
