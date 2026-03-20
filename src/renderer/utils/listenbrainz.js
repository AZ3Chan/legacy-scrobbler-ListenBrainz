import { usePrefs } from '../composables/usePrefs.js'
const { preferences, setPreferences } = usePrefs()

const debugEnabled = import.meta.env.DEV
const logDebug = (...args) => {
  if (debugEnabled) {
    console.log('[debug]', ...args)
  }
}

const MIN_TRACK_SECONDS = 40
const SHORT_TRACK_SECONDS = 60
const DEFAULT_TRACK_SECONDS = 180
const SCROBBLE_BUFFER_SECONDS = 30

// ─── Network check ────────────────────────────────────────────────────────────

export async function checkNetworkConnection () {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ online: false, error: 'No internet connection' })
    }, 5000)

    fetch('https://api.listenbrainz.org/1/validate-token?token=ping')
      .then(response => {
        clearTimeout(timeout)
        // Any response (even 401) means the server is reachable
        resolve({ online: true, error: null })
      })
      .catch(error => {
        clearTimeout(timeout)
        resolve({ online: false, error: 'No internet connection' })
      })
  })
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function connectListenBrainz () {
  // Nothing to open — the user just pastes their token.
  // This is a no-op kept for API symmetry; the UI calls listenbrainzLogin directly.
  return { success: true, error: null }
}

export async function login (token) {
  try {
    const result = await window.ipc.listenbrainzLogin(token)
    if (!result.success) {
      return { status: false, message: result.error || 'Invalid token.' }
    }
    await setPreferences('singleConfig', 'listenBrainz', {
      loggedIn: true,
      token,
      username: result.username
    })
    return { status: true, message: '' }
  } catch (error) {
    return { status: false, message: error.message }
  }
}

export async function updateProfile () {
  // With ListenBrainz the username is returned at login time, so there's
  // nothing extra to fetch. Just confirm the stored token is still valid.
  const token = preferences.listenBrainz?.token
  if (!token) {
    return false
  }
  try {
    const result = await window.ipc.listenbrainzLogin(token)
    if (result.success) {
      await setPreferences('singleConfig', 'listenBrainz', {
        loggedIn: true,
        username: result.username
      })
      return true
    }
    return false
  } catch {
    return false
  }
}

// ─── Track helpers (unchanged from original) ─────────────────────────────────

function isNonEmptyString (value) {
  return typeof value === 'string' && value.trim().length > 0
}

function clampTimestampSeconds (timestamp) {
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return now
  }
  return Math.min(timestamp, now)
}

function getSpacingSeconds (trackLengthMs) {
  const lengthMs =
    Number.isFinite(trackLengthMs) && trackLengthMs > 0
      ? trackLengthMs
      : DEFAULT_TRACK_SECONDS * 1000
  let seconds = Math.floor(lengthMs / 1000)
  if (seconds < MIN_TRACK_SECONDS) {
    seconds = SHORT_TRACK_SECONDS
  }
  return seconds + SCROBBLE_BUFFER_SECONDS
}

function isValidTrackMeta (track) {
  return isNonEmptyString(track?.track) && isNonEmptyString(track?.artist)
}

function normalizePlayCount (playCount) {
  if (!Number.isFinite(playCount)) return 0
  return Math.max(0, Math.floor(playCount))
}

function normalizeLastPlayed (lastPlayed) {
  if (!Number.isFinite(lastPlayed)) return 0
  return Math.max(0, Math.floor(lastPlayed))
}

function buildTrackKey (track) {
  const id = Number.isFinite(track?.id) ? track.id : 'no-id'
  const name = track?.track || ''
  const artist = track?.artist || ''
  const album = track?.album || ''
  const length = Number.isFinite(track?.length) ? track.length : ''
  return `${id}::${name}::${artist}::${album}::${length}`
}

function resolveLedgerState (track, ledgerEntry) {
  const playCount = normalizePlayCount(track.playCount)
  const storedCount = normalizePlayCount(ledgerEntry?.count)
  const storedLastPlayed = normalizeLastPlayed(ledgerEntry?.lastPlayed)
  const lastPlayed = normalizeLastPlayed(track.lastPlayed)
  const resetDetected = playCount < storedCount
  const hasNewTimestamp = lastPlayed > storedLastPlayed
  const ignoreLedger = resetDetected && hasNewTimestamp
  const treatAsAlreadySynced = resetDetected && !hasNewTimestamp

  return {
    playCount,
    storedCount,
    storedLastPlayed,
    lastPlayed,
    resetDetected,
    hasNewTimestamp,
    previousCount: ignoreLedger ? 0 : storedCount,
    treatAsAlreadySynced
  }
}

function buildScrobbles (track, count, anchorTimestamp) {
  const safeTimestamp = clampTimestampSeconds(anchorTimestamp)
  if (count <= 1) {
    return [{ ...track, lastPlayed: safeTimestamp }]
  }
  const spacingSeconds = getSpacingSeconds(track.length)
  const scrobbles = []
  for (let i = count - 1; i >= 0; i--) {
    scrobbles.push({
      ...track,
      lastPlayed: safeTimestamp - i * spacingSeconds
    })
  }
  return scrobbles
}

function prepareScrobbles (tracklist, allowRepeat, ledger, now) {
  const scrobbles = []
  const skipped = []
  const ledgerUpdates = {}
  let validTrackCount = 0
  let deltaPlayCount = 0
  let repeatResetCount = 0
  let repeatResetWithNewTimestamp = 0

  tracklist.forEach(track => {
    if (!isValidTrackMeta(track)) {
      skipped.push(track)
      return
    }
    validTrackCount += 1

    const key = buildTrackKey(track)
    const state = resolveLedgerState(track, ledger?.[key])
    if (state.playCount <= 0) return

    if (state.resetDetected) {
      repeatResetCount += 1
      if (state.hasNewTimestamp) repeatResetWithNewTimestamp += 1
    }
    if (state.treatAsAlreadySynced) return

    const deltaCount = allowRepeat
      ? Math.max(0, state.playCount - state.previousCount)
      : state.playCount > state.previousCount
        ? 1
        : 0

    if (deltaCount <= 0) return

    const anchorTimestamp =
      state.previousCount > 0 ? now : state.lastPlayed
    scrobbles.push(...buildScrobbles(track, deltaCount, anchorTimestamp))
    deltaPlayCount += deltaCount
    ledgerUpdates[key] = {
      count: state.playCount,
      lastPlayed: state.lastPlayed,
      syncedAt: now
    }
  })

  logDebug('prepareScrobbles', {
    inputTracks: tracklist.length,
    validTrackCount,
    scrobbles: scrobbles.length,
    skipped: skipped.length,
    ledgerUpdates: Object.keys(ledgerUpdates).length,
    allowRepeat,
    deltaPlayCount,
    repeatResetCount,
    repeatResetWithNewTimestamp
  })

  return {
    scrobbles: deconflictScrobbles(scrobbles),
    skipped,
    ledgerUpdates
  }
}

function deconflictScrobbles (scrobbles) {
  if (scrobbles.length <= 1) return scrobbles

  const sorted = scrobbles
    .slice()
    .sort((a, b) => b.lastPlayed - a.lastPlayed)

  let previousTimestamp = Math.floor(Date.now() / 1000) + 1
  return sorted.map(scrobble => {
    let timestamp = clampTimestampSeconds(scrobble.lastPlayed)
    if (timestamp >= previousTimestamp) {
      timestamp = previousTimestamp - 1
    }
    previousTimestamp = timestamp
    return { ...scrobble, lastPlayed: timestamp }
  })
}

export function filterTracksForLedger (tracklist, ledger) {
  const filtered = tracklist.filter(track => {
    const key = buildTrackKey(track)
    const state = resolveLedgerState(track, ledger?.[key])
    if (state.playCount <= 0) return false
    if (state.treatAsAlreadySynced) return false
    return state.playCount > state.previousCount
  })
  logDebug('filterTracksForLedger', {
    inputTracks: tracklist.length,
    filteredTracks: filtered.length
  })
  return filtered
}

export function countAlreadySyncedPlays (tracklist, ledger) {
  const total = tracklist.reduce((totalPlays, track) => {
    const key = buildTrackKey(track)
    const state = resolveLedgerState(track, ledger?.[key])
    if (state.playCount <= 0) return totalPlays
    if (state.treatAsAlreadySynced) return totalPlays + state.playCount
    if (state.previousCount <= 0) return totalPlays
    return totalPlays + Math.min(state.playCount, state.previousCount)
  }, 0)
  logDebug('countAlreadySyncedPlays', {
    inputTracks: tracklist.length,
    alreadySynced: total
  })
  return total
}

// ─── Scrobble submission ──────────────────────────────────────────────────────

/**
 * Convert our internal track shape to the array that listenbrainz.js (main)
 * expects: { artist, title, album, timestamp, duration }
 */
function toListenBrainzTrack (track) {
  return {
    artist: track.artist,
    title: track.track,
    album: track.album || '',
    timestamp: clampTimestampSeconds(track.lastPlayed),
    duration: track.length ? Math.floor(track.length / 1000) : undefined
  }
}

async function sendScrobbleRequest (tracklist, _timeout = 0) {
  try {
    logDebug('sendScrobbleRequest', { count: tracklist.length })
    const lbTracks = tracklist.map(toListenBrainzTrack)
    const result = await window.ipc.listenbrainzScrobble(lbTracks)
    return result.success
  } catch (error) {
    console.error('Error scrobbling:', error.message)
    return false
  }
}

export async function scrobbleTracks (tracklist, ledger = {}) {
  const now = Math.floor(Date.now() / 1000)
  const { scrobbles, skipped, ledgerUpdates } = prepareScrobbles(
    tracklist,
    preferences.repeatScrobbles,
    ledger,
    now
  )
  logDebug('scrobbleTracks', {
    tracklist: tracklist.length,
    scrobbles: scrobbles.length,
    skipped: skipped.length,
    ledgerUpdates: Object.keys(ledgerUpdates).length
  })

  if (scrobbles.length === 0) {
    return { status: false, scrobbles, skipped, ledgerUpdates: {} }
  }

  if (await sendScrobbleRequest(scrobbles)) {
    logDebug('scrobbleTracks success')
    return { status: true, scrobbles, skipped, ledgerUpdates }
  }

  logDebug('scrobbleTracks failed')
  return { status: false, scrobbles, skipped, ledgerUpdates: {} }
}

export async function scrobbleTracksIndividually (
  tracklist,
  updateTrackStatus,
  ledger = {}
) {
  const failedTracks = []
  const submittedScrobbles = []
  const skipped = []
  const ledgerUpdates = {}
  const now = Math.floor(Date.now() / 1000)
  logDebug('scrobbleTracksIndividually', { tracklist: tracklist.length })

  const promises = tracklist.map(async (track, index) => {
    try {
      if (!isValidTrackMeta(track)) {
        updateTrackStatus(index, 'failed')
        skipped.push(track)
        failedTracks.push(track)
        return
      }

      const key = buildTrackKey(track)
      const state = resolveLedgerState(track, ledger?.[key])
      const previousCount = state.treatAsAlreadySynced
        ? state.playCount
        : state.previousCount
      const deltaCount = preferences.repeatScrobbles
        ? Math.max(0, state.playCount - previousCount)
        : state.playCount > previousCount
          ? 1
          : 0

      if (deltaCount <= 0) {
        updateTrackStatus(index, 'success')
        return
      }

      const anchorTimestamp = previousCount > 0 ? now : state.lastPlayed
      const scrobbleList = buildScrobbles(track, deltaCount, anchorTimestamp)
      const success = await sendScrobbleRequest(scrobbleList, 30000)
      if (success) {
        updateTrackStatus(index, 'success')
        submittedScrobbles.push(...scrobbleList)
        ledgerUpdates[key] = {
          count: state.playCount,
          lastPlayed: state.lastPlayed,
          syncedAt: now
        }
      } else {
        updateTrackStatus(index, 'failed')
        failedTracks.push(track)
      }
    } catch (error) {
      console.error('Error scrobbling track', track, error)
      updateTrackStatus(index, 'failed')
      failedTracks.push(track)
    }
  })

  await Promise.all(promises)

  return {
    failedTracks,
    scrobbles: submittedScrobbles,
    skipped,
    ledgerUpdates
  }
}

// ─── Failed Scrobble Queue ────────────────────────────────────────────────────

export async function addToFailedQueue (tracks) {
  if (!tracks || tracks.length === 0) return

  const queuedAt = Math.floor(Date.now() / 1000)
  const queueItems = tracks.map(track => ({
    track: {
      track: track.track,
      artist: track.artist,
      album: track.album || '',
      length: track.length || 0,
      playCount: track.playCount || 1,
      lastPlayed: track.lastPlayed || queuedAt
    },
    queuedAt,
    attempts: 0
  }))

  const currentQueue = preferences.failedScrobbleQueue || []
  const newQueue = [...currentQueue, ...queueItems]
  await setPreferences('singleConfig', 'failedScrobbleQueue', newQueue)
  logDebug('addToFailedQueue', { added: tracks.length, queueSize: newQueue.length })
}

export function getFailedQueueCount () {
  return (preferences.failedScrobbleQueue || []).length
}

export async function clearFailedQueue () {
  await setPreferences('singleConfig', 'failedScrobbleQueue', [])
  logDebug('clearFailedQueue')
}

export async function retryFailedQueue (updateTrackStatus) {
  const queue = preferences.failedScrobbleQueue || []
  if (queue.length === 0) {
    return { succeeded: 0, failed: 0, remaining: 0 }
  }

  logDebug('retryFailedQueue start', { queueSize: queue.length })

  const succeeded = []
  const stillFailed = []

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]
    const scrobbleList = [{ ...item.track, lastPlayed: item.track.lastPlayed }]

    if (updateTrackStatus) updateTrackStatus(i, 'pending')

    const success = await sendScrobbleRequest(scrobbleList, 30000)

    if (success) {
      succeeded.push(item)
      if (updateTrackStatus) updateTrackStatus(i, 'success')
    } else {
      stillFailed.push({ ...item, attempts: (item.attempts || 0) + 1 })
      if (updateTrackStatus) updateTrackStatus(i, 'failed')
    }
  }

  await setPreferences('singleConfig', 'failedScrobbleQueue', stillFailed)

  logDebug('retryFailedQueue complete', {
    succeeded: succeeded.length,
    stillFailed: stillFailed.length
  })

  return {
    succeeded: succeeded.length,
    failed: stillFailed.length,
    remaining: stillFailed.length
  }
}
