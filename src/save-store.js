/**
 * SaveStore — browser-side persistence for game save envelopes.
 *
 * Used by two paths:
 *   - Hosted sessions on servers with save files disabled: the server pushes
 *     save envelopes over the socket (opcode 10) and asks for them back at
 *     session creation (opcode 11). The browser is the persistence layer.
 *   - LocalSession: the game's saveGame/saveData contract, backed here.
 *
 * Envelopes mirror homegames-common/save-games.js:
 *   { gameKey, versionId, savedAt, data }
 *
 * Keys are scoped by the caller (host for hosted play, 'local' for local
 * sessions) so saves from one server never leak into another.
 *
 * Backed by localStorage (synchronously available, survives reloads) with an
 * in-memory fallback when storage is unavailable (private browsing, quota).
 * The API is promise-based so the backend can move to IndexedDB without
 * touching callers.
 */

const STORAGE_PREFIX = 'hg-save:';

// Mirror of homegames-common/save-games.js MAX_SAVE_DATA_BYTES — keep in sync.
const MAX_SAVE_DATA_BYTES = 1024 * 1024;

// Version id used for games with no published versions (built-ins, local play).
// Mirror of homegames-common/save-games.js DEFAULT_VERSION_ID.
const DEFAULT_VERSION_ID = 'local-game-version';

const getStorage = () => {
    try {
        const testKey = STORAGE_PREFIX + '__test__';
        window.localStorage.setItem(testKey, '1');
        window.localStorage.removeItem(testKey);
        return window.localStorage;
    } catch (e) {
        return null;
    }
};

// JSON-round-trip the game's data and enforce the size cap. Returns the JSON
// string. Mirror of homegames-common/save-games.js serializeSaveData.
const serializeSaveData = (data) => {
    const json = JSON.stringify(data);
    if (json === undefined) {
        throw new Error('Save data must be JSON-serializable');
    }
    // if (json.length > MAX_SAVE_DATA_BYTES) { // Count UTF-8 bytes, like the server backend.
    if (new TextEncoder().encode(json).length > MAX_SAVE_DATA_BYTES) {
        throw new Error('Save data exceeds ' + MAX_SAVE_DATA_BYTES + ' bytes');
    }
    return json;
};

// Can a game at `versionId` (declaring compatibility with older versions)
// load this envelope? Mirror of homegames-common/save-games.js.
const isCompatibleSave = (envelope, versionId, compatibility) => {
    if (!envelope || typeof envelope !== 'object' || envelope.data === undefined) return false;
    if (envelope.versionId === versionId) return true;
    return Array.isArray(compatibility) && compatibility.indexOf(envelope.versionId) !== -1;
};

// Coalesce a burst of saves into one write: calls landing while a flush is
// pending replace the pending value and share its outcome. Mirror of
// homegames-common/save-games.js createDebouncedWriter.
const createDebouncedWriter = ({ intervalMs, write }) => {
    let lastWrite = 0;
    let pending = null;

    const flush = () => {
        const batch = pending;
        pending = null;
        lastWrite = Date.now();
        Promise.resolve()
            .then(() => write(batch.value))
            .then(() => batch.resolvers.forEach(resolve => resolve()))
            .catch(err => batch.rejecters.forEach(reject => reject(err)));
    };

    return (value) => new Promise((resolve, reject) => {
        if (pending) {
            pending.value = value;
            pending.resolvers.push(resolve);
            pending.rejecters.push(reject);
            return;
        }
        pending = { value, resolvers: [resolve], rejecters: [reject] };
        const delay = Math.max(0, intervalMs - (Date.now() - lastWrite));
        setTimeout(flush, delay);
    });
};

const createSaveStore = () => {
    const storage = getStorage();
    const memory = {}; // fallback: saves last for the page's lifetime

    const getSave = (key) => new Promise((resolve) => {
        try {
            const raw = storage ? storage.getItem(STORAGE_PREFIX + key) : memory[key];
            if (!raw) {
                resolve(null);
                return;
            }
            const envelope = JSON.parse(raw);
            resolve((envelope && typeof envelope === 'object') ? envelope : null);
        } catch (e) {
            resolve(null);
        }
    });

    const putSave = (key, envelope) => new Promise((resolve, reject) => {
        let raw;
        try {
            raw = JSON.stringify(envelope);
        } catch (err) {
            reject(err);
            return;
        }
        if (storage) {
            try {
                storage.setItem(STORAGE_PREFIX + key, raw);
                resolve();
                return;
            } catch (e) {
                // Quota exceeded or storage revoked — fall through to memory
            }
        }
        memory[key] = raw;
        resolve();
    });

    const deleteSave = (key) => new Promise((resolve) => {
        try {
            if (storage) storage.removeItem(STORAGE_PREFIX + key);
        } catch (e) {}
        delete memory[key];
        resolve();
    });

    return { getSave, putSave, deleteSave };
};

module.exports = {
    createSaveStore,
    createDebouncedWriter,
    serializeSaveData,
    isCompatibleSave,
    MAX_SAVE_DATA_BYTES,
    DEFAULT_VERSION_ID,
    STORAGE_PREFIX,
};
