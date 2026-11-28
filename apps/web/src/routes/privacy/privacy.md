---
title: Privacy Notice
description: How hosted Weft handles sign-in, synced notebooks, and privacy requests.
---

Last revised 28 November 2026.

## Who runs Weft and what this notice covers

I’m Musaab Khan. I operate hosted Weft at weft.page. This notice covers the website, accounts and sign-in, browser editor, and hosted sync relay. It does not cover independently self-hosted Weft installations or reMarkable’s own cloud service.

For privacy questions or requests, email me at [musaab.khan@protonmail.com](mailto:musaab.khan@protonmail.com). You do not need a Weft account.

## Information we use

- **Earlier beta registrations.** Before the beta opened, Clerk collected the email address you provided if you asked to hear about joining. The purpose was to manage invitations and contact people about their requests. If you want to ask about that information or have it removed, email me.

- **Account and sign-in information.** Clerk handles sign-in, including Google sign-in. The relay uses your Clerk account ID to associate your synced notebooks with your account. When you’re signed in, Weft displays your primary email address, or your username or account ID if no primary email address is available.

- **Your synced library.** Pairing your tablet with hosted Weft sends a copy of your synced notebooks and related library data to the relay. This can include titles and folders, handwriting and typed text, PDFs and images, and edit history. Weft also uses pairing and device identifiers to connect your tablet to the right account. The Weft software installed on your tablet reads local notebook files to send changes and updates those files when it applies changes from the relay.

- **Service and support information.** Running the service can involve processing network and request information, such as an IP address or request details. If you contact me, I receive your contact details and what you choose to send. If the relay receives a sync failure report, it can include an error message, app version, source, timestamp, and diagnostic details such as hashed notebook or page identifiers.

## How we use it

We use account, device, and notebook information to provide the service you ask for: signing in, pairing a tablet, syncing notebooks, editing in the browser, and keeping revisions and backups. We use limited operational information to keep the service working and secure, respond to support and privacy requests, and comply with applicable legal obligations.

Where data protection law requires a lawful basis, I use account and sync information as necessary to provide the service you request under our agreement. Where appropriate, I rely on legitimate interests to manage beta access, keep the service secure and reliable, and respond to requests. I process information to comply with legal obligations when required. Weft does not use notebook contents for advertising or to train AI models.

**Hosted sync is not end-to-end encrypted.** The relay can read the notebook data it needs to process. Do not use hosted Weft as your only copy of important material or to store clinical records or regulated third-party files.

## Information about other people

A notebook you sync can contain information about someone else. Weft receives that information from the notebook, not from the person it’s about. I do not search notebooks to identify or contact the people mentioned in them. If you believe a notebook contains information about you, you can make a privacy request even if you don’t use Weft. Please describe the request without attaching a notebook or sensitive files.

## Providers and storage locations

- **Netcup** hosts the notebook relay in Nürnberg, Germany.

- **Cloudflare** delivers the website and proxies traffic to and from the relay. It terminates HTTPS at its network edge and can process connection information, request headers, and the contents of traffic it forwards, including synced notebook data.

- **Clerk** handles account authentication. If you sign in with Google, **Google** handles that part of sign-in.

- **tldraw** provides the editor SDK. Its license check sends the editor URL and license and SDK information to tldraw. The URL can include notebook and page identifiers. The license request does not contain notebook text, handwriting, or files.

Nürnberg is the location of the primary notebook relay. Service administration, traffic delivery, and authentication may involve access or processing outside Germany.

## Browser storage

Weft and its sign-in provider use browser storage for session and service functions. Weft can also keep copies of notebook pages, thumbnails, and pending edits in your browser so it can reopen them and support offline use. Signing out does not necessarily clear those copies. You can clear Weft site data in your browser settings, but save or sync pending edits first.

## How long information stays

I keep synced notebook data and revisions while they are stored in your hosted library. Disconnecting a tablet does not start a deletion or retention timer. The beta does not automatically delete inactive accounts.

A deleted live copy can remain in rolling recovery backups until those backups are replaced. The relay normally keeps the latest 24 successful backups and makes them roughly hourly; a failed backup can extend that window. A request to delete hosted data is separate from deleting files from your tablet or clearing your browser.

I keep support messages and service records as needed to handle requests, diagnose problems, keep Weft secure, and meet any applicable legal obligations. The relay stores up to 200 sync failure reports per account.

## Your choices and rights

For access, a copy, correction, or deletion, email [musaab.khan@protonmail.com](mailto:musaab.khan@protonmail.com). I may need to verify your identity and what the request covers. Depending on the law that applies, you may also have rights to restrict processing, object to processing based on legitimate interests, receive a portable copy, or complain to a data protection authority.

Disconnecting your tablet stops syncing but does not remove the hosted copy. Deleting your Google account or clearing your browser does not delete data on the relay. Deleting hosted data does not erase your original tablet files, local browser copies on other devices, or files you exported.

## Changes to this notice

I may update this notice as Weft changes. The revision date shows when it was last updated. I’ll bring significant changes to affected people’s attention and tell them before using their existing personal data for a new purpose.
