/**
 * Loads `.env` before anything can read `process.env`.
 *
 * This is a module rather than a couple of lines in `index.ts` because of when
 * module bodies run. `import` declarations are hoisted: every module
 * `index.ts` imports — `./config.ts` among them, directly — is fully evaluated
 * before the first statement of `index.ts` executes. So a `config()` call
 * sitting at the top of that file still ran *after* `config.ts` had already
 * captured `process.env.WORKSPACE_CONTROL_PORT` into a module-level constant,
 * and setting the control port in `.env` quietly did nothing at all. The same
 * went for `NODE_ENV`.
 *
 * Importing this module first is what actually makes it first, because imports
 * are evaluated in the order they are written.
 *
 * Packaged builds deliberately load nothing: `dotenv` reads `.env` relative to
 * the current working directory, which for an installed app is whatever
 * directory it happened to be launched from. A file planted there could
 * otherwise redirect the control port and the user data directory of an app
 * the user started by double-clicking it.
 */

import * as electron from 'electron'
import { config as loadEnvFile } from 'dotenv'

const electronApp = (electron as unknown as { app?: { isPackaged?: boolean } }).app

if (!electronApp?.isPackaged) loadEnvFile()
