// Preview-only stand-in for expo-sqlite: no device database is opened or written.
const unavailable = () => { throw new Error('Synthetic preview: device database unavailable.'); };
export const openDatabaseAsync = async () => unavailable();
export const openDatabaseSync = unavailable;
export type SQLiteDatabase = never;
