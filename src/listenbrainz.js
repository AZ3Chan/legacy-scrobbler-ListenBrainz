/**
 * listenbrainz.js  –  main-process ListenBrainz integration
 *
 * Written as an ES module so Vite bundles it directly into main.js,
 * exactly the same way readDB.js is bundled.  No Vite-config changes needed.
 */

import { net } from 'electron'

const LB_API_ROOT = 'https://api.listenbrainz.org'

// ─── Low-level HTTP helpers ───────────────────────────────────────────────────

function apiPost (path, body, token) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'POST', url: `${LB_API_ROOT}${path}` })
    request.setHeader('Content-Type', 'application/json')
    request.setHeader('Authorization', `Token ${token}`)

    let responseData = ''
    request.on('response', response => {
      response.on('data', chunk => { responseData += chunk })
      response.on('end', () => {
        try {
          const json = JSON.parse(responseData)
          if (response.statusCode === 200) {
            resolve(json)
          } else {
            reject(new Error(`ListenBrainz API error ${response.statusCode}: ${json.error || responseData}`))
          }
        } catch (e) {
          reject(new Error(`Failed to parse ListenBrainz response: ${e.message}`))
        }
      })
    })
    request.on('error', err => reject(err))
    request.write(JSON.stringify(body))
    request.end()
  })
}

function apiGet (path) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url: `${LB_API_ROOT}${path}` })

    let responseData = ''
    request.on('response', response => {
      response.on('data', chunk => { responseData += chunk })
      response.on('end', () => {
        try {
          const json = JSON.parse(responseData)
          if (response.statusCode === 200) {
            resolve(json)
          } else {
            reject(new Error(`ListenBrainz API error ${response.statusCode}: ${json.error || responseData}`))
          }
        } catch (e) {
          reject(new Error(`Failed to parse ListenBrainz response: ${e.message}`))
        }
      })
    })
    request.on('error', err => reject(err))
    request.end()
  })
}

// ─── Token storage (in-memory) ────────────────────────────────────────────────

let _token = null

export function saveToken (token) { _token = token }
export function getToken () { return _token }
export function clearToken () { _token = null }

// ─── Public API ───────────────────────────────────────────────────────────────

export async function authenticate (token) {
  const data = await apiGet(`/1/validate-token?token=${encodeURIComponent(token)}`)
  if (!data.valid) {
    throw new Error('Invalid ListenBrainz token. Please check and try again.')
  }
  saveToken(token)
  return data.user_name
}

export function isAuthenticated () {
  return Boolean(_token)
}

export function logout () {
  clearToken()
}

export async function scrobbleTracks (tracks) {
  const token = getToken()
  if (!token) throw new Error('Not authenticated with ListenBrainz.')

  const CHUNK_SIZE = 1000
  for (let i = 0; i < tracks.length; i += CHUNK_SIZE) {
    const chunk = tracks.slice(i, i + CHUNK_SIZE)
    const payload = chunk.map(t => {
      const entry = {
        listened_at: t.timestamp,
        track_metadata: {
          artist_name: t.artist,
          track_name: t.title,
          additional_info: {
            submission_client: 'Legacy Scrobbler',
            media_player: 'iPod'
          }
        }
      }
      if (t.album) entry.track_metadata.release_name = t.album
      if (t.duration) entry.track_metadata.additional_info.duration = t.duration
      return entry
    })
    await apiPost('/1/submit-listens', { listen_type: 'import', payload }, token)
  }
}
