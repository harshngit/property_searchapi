# Open-source licence register

Handover deliverable. Every third-party component shipped in PropertySerch, with its licence.
Generated on 3 Nov 2026 from each repo's `package.json` and installed `node_modules`.
To refresh it after a dependency change, run `npm ls --omit=dev --all --json --long` in each repo and update the tables.

## Result

- **No copyleft licences** (GPL, LGPL, AGPL, MPL, EPL, CC-BY-SA) in any app, direct or transitive.
- All licences are permissive (MIT, Apache-2.0, BSD, ISC, 0BSD, BlueOak, Python-2.0, Zlib, SIL OFL for fonts). They allow commercial, closed-source use.
- Obligations: keep each package's copyright and licence notice (they ship inside `node_modules` and the built bundles' licence comments). Apache-2.0 packages also require keeping any NOTICE file and stating changes if a package itself is modified (none are).

## Production dependency tree (transitive), by licence

| App | Packages | Licences |
|---|---|---|
| Backend API (property_searchapi) | 351 | MIT 286, Apache-2.0 22, ISC 14, BSD-2-Clause 12, BlueOak-1.0.0 9, BSD-3-Clause 5, (MIT AND Zlib) 1, 0BSD 1, Python-2.0 1 |
| CRM (property_dashboard) | 81 | MIT 58, ISC 11, Apache-2.0 9, 0BSD 1, MIT AND ISC 1, BSD-3-Clause 1 |
| Website and mobile app (propert_website) | 22 | MIT 21, 0BSD 1 |

`exif-parser` 0.1.12 (used by `jimp`) declares no licence in its package.json; its LICENSE.md is MIT.

## Backend API (property_searchapi): direct dependencies

| Package | Version | Used for | Licence | Source |
|---|---|---|---|---|
| `@anthropic-ai/sdk` | 0.32.1 | shipped | MIT | https://github.com/anthropics/anthropic-sdk-typescript |
| `@google-cloud/storage` | 7.22.0 | shipped | Apache-2.0 | https://github.com/googleapis/google-cloud-node/tree/main/handwritten/storage |
| `bcryptjs` | 2.4.3 | shipped | MIT | https://github.com/dcodeIO/bcrypt.js |
| `cheerio` | 1.0.0 | shipped | MIT | https://cheerio.js.org/ |
| `cors` | 2.8.6 | shipped | MIT | expressjs/cors |
| `dotenv` | 16.6.1 | shipped | BSD-2-Clause | https://github.com/motdotla/dotenv#readme |
| `exifr` | 7.1.3 | shipped | MIT | https://mutiny.cz/exifr/ |
| `express` | 4.22.2 | shipped | MIT | http://expressjs.com/ |
| `express-rate-limit` | 7.5.1 | shipped | MIT | https://github.com/express-rate-limit/express-rate-limit |
| `express-validator` | 7.3.2 | shipped | MIT | https://express-validator.github.io |
| `google-auth-library` | 11.0.2 | shipped | Apache-2.0 | https://github.com/googleapis/google-cloud-node/tree/main/core/packages/google-auth-library-nodejs |
| `helmet` | 7.2.0 | shipped | MIT | https://helmetjs.github.io/ |
| `jimp` | 1.6.1 | shipped | MIT | jimp-dev/jimp |
| `jsonwebtoken` | 9.0.3 | shipped | MIT | https://github.com/auth0/node-jsonwebtoken |
| `jsqr` | 1.4.0 | shipped | Apache-2.0 | https://github.com/cozmo/jsQR |
| `morgan` | 1.11.0 | shipped | MIT | expressjs/morgan |
| `multer` | 2.2.0 | shipped | MIT | expressjs/multer |
| `pdf-lib` | 1.17.1 | shipped | MIT | https://pdf-lib.js.org |
| `pdf-parse` | 1.1.1 | shipped | MIT | https://gitlab.com/autokent/pdf-parse |
| `pg` | 8.22.0 | shipped | MIT | https://github.com/brianc/node-postgres |
| `socket.io` | 4.8.4 | shipped | MIT | https://github.com/socketio/socket.io/tree/main/packages/socket.io#readme |
| `swagger-jsdoc` | 6.3.0 | shipped | MIT | https://github.com/Surnet/swagger-jsdoc |
| `swagger-ui-express` | 5.0.1 | shipped | MIT | https://github.com/scottie1984/swagger-ui-express |
| `tesseract.js` | 5.1.1 | shipped | Apache-2.0 | https://github.com/naptha/tesseract.js |
| `uuid` | 9.0.1 | shipped | MIT | https://github.com/uuidjs/uuid |
| `autocannon` | 7.15.0 | build / development only (load test) | MIT | https://github.com/mcollina/autocannon |
| `c8` | 10.1.3 | build / development only (test coverage) | ISC | https://github.com/bcoe/c8 |
| `nodemon` | 3.1.14 | build / development only | MIT | https://nodemon.io |
| `qrcode` | 1.5.4 | build / development only | MIT | http://github.com/soldair/node-qrcode |

## CRM (property_dashboard): direct dependencies

| Package | Version | Used for | Licence | Source |
|---|---|---|---|---|
| `@headlessui/react` | 2.2.10 | shipped | MIT | https://github.com/tailwindlabs/headlessui |
| `@reduxjs/toolkit` | 2.12.0 | shipped | MIT | https://redux-toolkit.js.org |
| `clsx` | 2.1.1 | shipped | MIT | lukeed/clsx |
| `framer-motion` | 12.43.0 | shipped | MIT | https://github.com/motiondivision/motion/ |
| `react` | 19.2.8 | shipped | MIT | https://react.dev/ |
| `react-dom` | 19.2.8 | shipped | MIT | https://react.dev/ |
| `react-icons` | 5.7.0 | shipped | MIT | https://github.com/react-icons/react-icons#readme |
| `react-redux` | 9.3.0 | shipped | MIT | https://github.com/reduxjs/react-redux |
| `react-router-dom` | 7.18.2 | shipped | MIT | https://github.com/remix-run/react-router |
| `recharts` | 3.10.1 | shipped | MIT | https://github.com/recharts/recharts |
| `socket.io-client` | 4.8.4 | shipped | MIT | https://github.com/socketio/socket.io/tree/main/packages/socket.io-client#readme |
| `@types/react` | 19.2.18 | build / development only | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react |
| `@types/react-dom` | 19.2.4 | build / development only | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react-dom |
| `@vitejs/plugin-react` | 6.0.5 | build / development only | MIT | https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#readme |
| `autoprefixer` | 10.5.4 | build / development only | MIT | postcss/autoprefixer |
| `oxlint` | 1.76.0 | build / development only | MIT | https://oxc.rs/docs/guide/usage/linter |
| `postcss` | 8.5.25 | build / development only | MIT | https://postcss.org/ |
| `tailwindcss` | 3.4.19 | build / development only | MIT | https://tailwindcss.com |
| `vite` | 8.2.0 | build / development only | MIT | https://vite.dev |

## Website and mobile app (propert_website): direct dependencies

| Package | Version | Used for | Licence | Source |
|---|---|---|---|---|
| `@capacitor-community/background-geolocation` | 1.2.26 | shipped | MIT | https://github.com/capacitor-community/background-geolocation |
| `@capacitor/core` | 7.6.9 | shipped | MIT | https://capacitorjs.com |
| `react` | 18.3.1 | shipped | MIT | https://reactjs.org/ |
| `react-dom` | 18.3.1 | shipped | MIT | https://reactjs.org/ |
| `react-router-dom` | 7.18.2 | shipped | MIT | https://github.com/remix-run/react-router |
| `socket.io-client` | 4.8.4 | shipped | MIT | https://github.com/socketio/socket.io/tree/main/packages/socket.io-client#readme |
| `yet-another-react-lightbox` | 3.32.2 | shipped | MIT | https://yet-another-react-lightbox.com |
| `@capacitor/android` | 7.6.9 | build / development only | MIT | https://capacitorjs.com |
| `@capacitor/cli` | 7.6.9 | build / development only | MIT | https://capacitorjs.com |
| `@capacitor/ios` | 7.6.9 | build / development only | MIT | https://capacitorjs.com |
| `autoprefixer` | 10.5.4 | build / development only | MIT | postcss/autoprefixer |
| `postcss` | 8.5.26 | build / development only | MIT | https://postcss.org/ |
| `tailwindcss` | 3.4.19 | build / development only | MIT | https://tailwindcss.com |
| `vite` | 5.4.21 | build / development only | MIT | https://vite.dev |

## Other third-party components (not npm dependencies)

| Component | Where | Licence | Notes |
|---|---|---|---|
| Leaflet 1.9.4 | Website and CRM map picker, loaded from unpkg.com | BSD-2-Clause | |
| OpenStreetMap tiles and data | Website and CRM maps (tile.openstreetmap.org) | ODbL 1.0 (data), CC BY-SA 2.0 (tiles) | The map must show "© OpenStreetMap contributors". The OSM tile servers are not meant for heavy production traffic; see the open map-tiles decision in REMAINING.md. Attribution is not copyleft on the app code. |
| Google Maps (geocoding link) | Website | Google Maps Platform Terms | Commercial terms, not open source. |
| Tesseract language data (eng, hin) | Backend OCR (`tesseract.js`), downloaded on first use | Apache-2.0 | |
| Lato | Website fonts (`src/Web Fonts`) | SIL Open Font License 1.1 | Fonts may be bundled and used commercially; they may not be sold on their own. |
| Plus Jakarta Sans | Website fonts | SIL Open Font License 1.1 | Same as above. |
| Inter | Website fonts | SIL Open Font License 1.1 | Same as above. |

## Hosted services (commercial terms, not open source)

OpenAI API, Anthropic (Claude) API, Razorpay, Meta WhatsApp Cloud API, Telegram Bot API, Google Cloud Storage, AWS. Their terms and data processing agreements are listed under Go-live in REMAINING.md.
