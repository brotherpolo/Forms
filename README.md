# Formwright

A form builder for phone and desktop, running on Firebase.

- **Form designer** with 26 field types: text, long text, email, phone, website, location, whole number, decimal, currency, percent, rating, slider, calculation, date, time, date and time, yes/no, dropdown, single choice, multiple choice, file upload, photo, signature, color, link to record, and section heading.
- **Sidebar control**: choose which forms appear in the sidebar. Hidden forms stay reachable from their parent records.
- **Related forms**: parent/child forms ("Add project" from a client), with optional copying of matching fields, plus "Link to record" lookups.
- **Calculations**: formulas such as `ROUND({Budget} * 1.13, 2)`, `IF(...)`, `DAYS({Due}, TODAY())`, and `CHILDSUM("Projects", "Budget")`.
- **Security groups**: per-form *view* and *edit* levels of **none**, **own** (records the person created) or **all**. Firestore and Storage security rules enforce them.

Plain JavaScript modules, built with Vite. The only runtime dependency is the Firebase JS SDK.

---

## How permissions work

| Role | What they can do |
|---|---|
| **Administrator** | Everything: design forms, manage groups and users, see and edit every record. |
| **Member** | Only what their security groups allow. A member with no groups sees nothing. |

Each **security group** has a default level for every form, plus optional per-form exceptions. Each level has two parts:

| | none | own | all |
|---|---|---|---|
| **Can see** | hidden | records they created | every record |
| **Can edit** (create, change, delete) | read only | records they created | every record |

The designer offers presets: *View and edit all*, *View and edit mine only*, *View all, edit mine*, *View all, read only*, and *No access*.

When a person belongs to several groups, the most generous level wins, form by form. Editing implies seeing.

### How it is enforced

1. When an admin saves a group or changes someone's groups, the admin's browser computes that person's **effective access**. It writes the result to `users/{uid}.access`, for example `{ "*": {view:"own", edit:"own"}, "f_clients": {view:"all", edit:"none"} }`.
2. `firestore.rules` reads that map on every request.
   - A member may read a record only if they have `all`, or `own` and they are the `ownerId`.
   - They may write under the same test against their edit level.
   - `ownerId`, `createdBy` and `formId` can never change after creation.
   - `updatedBy` must be the caller.
3. `storage.rules` applies the same map to uploads at `uploads/{formId}/{uploaderUid}/…`, using cross-service rules.
4. Only admins can write `forms`, `groups`, or anyone's `role`, `groups` or `access`. New accounts must start as members with no access.

The UI hides what a person can't do (New buttons, Save, the designer). The rules are the real boundary.

---

## Project layout

```
index.html                 App shell
src/
  main.js                  Waits for sign-in, creates the account, starts the app
  firebase.js              Firebase init from .env.local; emulator switch
  store.js                 Firestore subscriptions and writes, Storage uploads, group/access writes
  access.js                Permission model (pure; mirrored by the rules)
  formulas.js              Formula parser and evaluator (no eval)
  app.js                   Navigation, record list and record screens, form designer
  admin.js                 Security groups and users screens (admins only)
  auth.js                  Sign-in screen: Google, email and password, password reset
  ui.js, util.js           Shared helpers
  styles.css               All styles (light and dark)
  examples.json            Example forms an admin can load from the designer
firestore.rules            Database security rules
storage.rules              File upload rules
firestore.indexes.json     No composite indexes needed
firebase.json, .firebaserc Firebase CLI config
tests/unit/                Formula and permission tests (node --test)
tests/rules/               Security rules tests (run against the emulators)
scripts/make-admin.mjs     Promote a user to administrator
.github/workflows/deploy.yml  Test on every PR; deploy on push to main
```

### Data model (Firestore)

| Collection | Document | Written by |
|---|---|---|
| `forms/{formId}` | `name, itemName, description, color, showInSidebar, order, titleField, fields[], children[]` | admins |
| `records/{id}` | `formId, values{fieldId: value}, parentId, parentFormId, ownerId, createdBy, createdAt, updatedAt, updatedBy` | per access |
| `groups/{id}` | `name, description, access{formId or "*": {view, edit}}` | admins |
| `users/{uid}` | `email, displayName, role, groups[], access{…}, createdAt` | self on first sign-in; admins after |
| `profiles/{uid}` | `displayName` (readable by everyone signed in, for "Created by") | self |

Files go to Cloud Storage. The record stores `{name, size, type, path, url}`. Signatures are stored inline as small PNG data URLs.

---

## Setup

### 1. Create the Firebase project

1. In the [Firebase console](https://console.firebase.google.com), create a project.
2. **Authentication → Sign-in method**: enable **Email/Password** and **Google**.
3. **Firestore Database**: create a database in production mode, in your region.
4. **Storage**: get started. Storage needs the Blaze (pay-as-you-go) plan on projects created since late 2024. Its free usage tier still applies.
5. **Project settings → General → Your apps**: add a **Web app**, then copy its config values.
6. **Authentication → Settings → Authorized domains**: add any custom domain you'll host on.

### 2. Run locally

```bash
npm install
cp .env.example .env.local      # paste your web app config
npx firebase login
npx firebase use --add          # pick your project (updates .firebaserc)
npm run deploy:rules            # deploy firestore.rules and storage.rules first
npm run dev                     # http://localhost:5173
```

The first `deploy:rules` asks to let Storage rules read Firestore. Accept.

### 3. Make yourself the first admin

1. Sign in to the app once. This creates your `users/{uid}` document as a member.
2. Then do one of these:
   - **Console:** Firestore → `users` → your document → set `role` to `admin`.
   - **Script:** create a service account key (Project settings → Service accounts → Generate new private key), save it outside the repo, then run:
     ```bash
     GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npm run make-admin -- you@example.com
     ```
3. Reload the app. You now see **Form designer**, **Security groups** and **Users**.
4. In the designer, **Load example forms** gives you a working set to explore.

### 4. Give people access

1. People sign in once. They then appear under **Users**.
2. Create groups under **Security groups**. For example:
   - *Office*: View and edit all.
   - *Field staff*: View and edit mine only, with Clients set to "View all, read only".
3. Add people to groups, either from the group page or the Users page.

Changes apply immediately. The person's app re-subscribes to exactly the records they may see.

---

## Local development with emulators

```bash
# .env.local:  VITE_USE_EMULATORS=true   (no real config needed)
npm run emulators        # Auth, Firestore, Storage, Hosting + Emulator UI at http://127.0.0.1:4000
npm run dev
npm run make-admin -- you@example.com --emulator
```

Emulator data is saved to `.emulator-data/` on exit (git-ignored).

## Tests

```bash
npm run test:unit        # formulas and permission logic (no Firebase needed)
npm run test:rules       # security rules against the emulators (needs Java 11+)
```

The rules tests cover each permission level:
- reading, listing, creating, editing and deleting
- ownership can't be changed
- self-promotion is blocked
- new-account restrictions
- Storage upload and read paths

---

## Deploying with GitHub Actions

`.github/workflows/deploy.yml` runs unit tests, rules tests and a build on every pull request. On a push to `main` it also deploys Hosting, Firestore rules and Storage rules.

### Repository settings

**Secrets** (Settings → Secrets and variables → Actions):

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | JSON key of a service account with the **Firebase Admin** role. A tighter alternative: **Firebase Hosting Admin**, **Firebase Rules Admin** and **Service Account User**. |
| `VITE_FIREBASE_API_KEY` | Web API key. It's not a secret, but this keeps it out of logs. |

**Variables:**

| Name | Example |
|---|---|
| `FIREBASE_PROJECT_ID` | `my-forms-prod` |
| `VITE_FIREBASE_AUTH_DOMAIN` | `my-forms-prod.firebaseapp.com` |
| `VITE_FIREBASE_STORAGE_BUCKET` | `my-forms-prod.firebasestorage.app` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | `1234567890` |
| `VITE_FIREBASE_APP_ID` | `1:1234567890:web:abc123` |

Create a `production` environment in GitHub if you want deploy approvals. The deploy job uses it.

Manual deploy: `npm run deploy`.

---

## Things to know

- **Calculations only see records the person can see.** `CHILDSUM` and similar functions total the child records the viewer has access to. A "mine only" member sees totals of their own children only. Calculation results are also saved on the record when it's saved.
- **Access is recomputed by the admin's browser.** This avoids needing Cloud Functions. If a write is interrupted, Security groups → **Recalculate access** rebuilds everyone's map. A server-side alternative is a Cloud Function on `groups/*` and `users/*` writes. The rules would not change.
- **File links.** Uploads are protected by `storage.rules`. The download URL saved on the record carries a token, though, so anyone who can read the record can open the file. That's the intended audience, but a forwarded link keeps working until the file is deleted.
- **Scale.** The app subscribes to every record the person can see, one query per form. That's fine into the low thousands of records per form. Beyond that, add paging and an `orderBy('updatedAt')` index.
- **Offline.** Firestore's persistent cache keeps forms and records readable without signal and queues edits. File uploads need a connection.
- **Deleting a form** deletes its records (admins only). Child records in other forms are kept.
- **Renaming a field** updates calculations that reference it, including `CHILDSUM`/`PARENT` references in related forms.
