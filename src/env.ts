/**
 * Loads environment variables before anything else.
 * Import this FIRST in entry points (`import "./env.js"`) — ESM imports are
 * hoisted, so calling dotenv.config() in the entry file body would run after
 * imported modules have already been evaluated.
 */

import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config(); // fall back to .env for anything not set above
