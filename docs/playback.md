# Playback: settings, Up Next and setlists

Design for listening to and performing with songs, not only practising one at a time. Interfaces it adds are
specified in `contract.md`; this file explains the model and where things go in the UI. Steps marked *(planned)* are not
built yet.

## Words
- **Processing**: songs being imported or split into stems (the server-side job queue, formerly "Queue").
- **Up Next**: what plays after the current song on this device. Never called "queue" in the UI.
- **Setlist**: a saved, named, ordered list of songs, for listening or for the stage. *(planned)*

## Settings
A *settings set* holds the playback preferences: the mixer (volume, mute, solo per stem), speed (a multiplier), key
(semitones relative to the original, plus the key switch), which stems follow the key, the metronome click on/off and
the click sound. Speed and key are relative so a set can apply to any song.

What belongs to the song itself is never part of a set: the tempo map, its click patterns, drum line breaks and the
analysis. They always come from the song.

Sets live in three places:

| Source | Stored | Scope | Offered | Typical use |
| --- | --- | --- | --- | --- |
| Song settings | one per song (`songs.settings`) | the song, everywhere | always | practice |
| Setlist settings | one per setlist entry | the song in that setlist | while playing a setlist *(planned)* | stage |
| Listening settings | one per user (`users.listening_settings`) | every song | always *(planned)* | listening |

One switch picks the source, and the player reads **and writes** only that source. There is no mixing or inheritance:
every value you hear comes from the selected set, and every change you make goes back to it. Data moves between sources
only through explicit actions ("Save as song settings", "Copy to setlist entry"). A setlist entry gets a *copy* of the
song settings when it is added, so practising later never changes a rehearsed setlist.

Switching the source by hand applies the new set at once (an A/B comparison). A song played from a setlist that is not
in it (added with Play next) uses its song settings while the switch is on Setlist, and says so.

### Persistence without waiting
- **Read**: `SongDetail.settings` arrives with the song, which the player already waits for, so there is no extra
  request and nothing flashes from defaults to the saved values.
- **Write**: the store and the engine change at once; the set is saved behind the UI (debounced, one request in flight,
  a keepalive request when the page goes away).
- **Failure**: unlike the tempo map, a failed save does not roll back what you hear. The unsent set stays in
  localStorage and is sent again on the next change, when the browser comes back online, or the next time the song
  opens (it wins over the server copy, being newer).
- **Migration**: a song without server settings is seeded from this browser's old per-song mixer and its global
  "stems that follow the key" and click sound, then saved, and the old mixer key is removed.
- **Conflicts**: last write wins. It is one user's data; two devices editing one song at the same moment is rare.

## UI placement
Same kind of thing, same component; one home per control; settings are edited in the player, never on a separate page.

| What | Where | Pattern |
| --- | --- | --- |
| Processing | main nav (was Queue); `/queue` redirects to `/processing` | count badge |
| Setlists | `Songs \| Setlists` pill tabs at the top of the Library *(planned)* | `pill` tabs, like Chords \| Drums |
| Settings source | chip on the player header's subtitle line, opening an `ActionMenu` radio group plus the copy actions *(planned)* | single choice |
| Up Next | player header button left of More, with a count badge, opening a `ResponsivePanel` *(planned)* | panel of controls |
| Play next, Add to Up Next, Add to setlist… | song `ActionMenu` in the Library; Add to setlist… also in the player's More menu *(planned)* | song actions |
| Add to Up Next gesture | swipe a Library song right (left is Delete) *(planned)* | `use-swipe-action` |
| Next / previous song | mini player, Up Next panel, lock screen, command palette *(planned)* | Media Session, `useCommands` |
| Mini player | above the bottom nav on phones, bottom of the main area on desktop | `glass`, like the nav |
| "Next: …" after a song that stops | the player's floating status slot *(planned)* | loading/error slot |

The transport row keeps its five practice buttons; previous/next song do not go there (seven 44 px buttons do not fit a
phone, and "next song" next to "+10 s" invites mis-taps on stage). The source chip is muted for Song settings and
accented otherwise; the mini player shows the source only when it is not Song settings. Closing the player sheet
shrinks it to the mini player and returns to the page it was opened from, instead of stopping playback.

Stage view *(planned)*: a full-screen view entered with Perform on a setlist: large type, next song, a touch lock,
screen wake lock, page-turner pedals (they send `PageDown`/`ArrowRight`, registered as commands), count-in, and
"Make available offline" for the whole setlist (stems cached by song and stem, not by presigned URL).

## Steps
1. Rename Queue to Processing. *(done)*
2. Song and listening settings in the database, synced behind the UI. *(done)*
3. Player outlives the song route; mini player. *(done)*
4. Up Next, with the Song / Listening switch; Media Session next/previous.
5. Setlists with per-entry settings; Setlist option on the switch; copy actions.
6. Stage view and offline setlists.
