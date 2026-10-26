/** Mirador's own identity for the commits it makes to snapshot a tour's working tree, so the user's git config never applies. */
export const IDENTITY = ["-c", "user.name=mirador", "-c", "user.email=mirador@localhost", "-c", "commit.gpgsign=false"];
/**
 * core.safecrlf=true makes git add refuse a file whose line endings it would not check out as they are; a snapshot
 * takes the files as they are.
 */
export const WITHOUT_SAFECRLF = ["-c", "core.safecrlf=false"];
