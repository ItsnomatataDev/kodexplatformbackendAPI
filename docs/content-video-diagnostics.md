# Schedule reviews, playback, and resource diagnostics

Both repositories must be released together: `kode-platform` and
`ITsNomatataWorkSpace`. Internal review writes now use the authenticated Kode
`POST /api/content-studio/internal-reviews/:token/feedback` endpoint.
The API checks the reviewer role, organization, office, token expiry, and slot.
Comments, status changes, and activity are committed under a schedule row lock.
Client feedback continues to use the client-session endpoint.

## Findings from the configured local services

The read-only video probe sampled five recent schedule assets. All five existed
in MinIO, had sizes matching their database metadata, and returned correct 206
responses for beginning and suffix ranges. Three contained `hvc1` markers and two
contained `avc1` markers. All five had a `moov` marker in the sampled tail, absent
from the first 64 KiB. These are container hints, not a full codec/decode test.
This verifies the local stores, not the production proxy or the user's browser.

Staff playback capabilities previously expired after 60 seconds. They now last
one hour and still require object ownership on every read. The player renews
failed access before remounting and restores its position. Decode failures stop
automatic retries. Video uses its native `src` so failures reach the video error
handler rather than being lost on a child `<source>`. QuickTime is no longer
labelled MP4. CORS permits Range and exposes response range headers.

## Repeatable video check

Run with the target environment's existing database and MinIO configuration:

```sh
npm run diagnose:content-videos -- 10
```

This reads at most 50 asset rows, checks object metadata, and samples only 64 KiB
from each end. It does not migrate data, rewrite videos, or contact Supabase.
The output includes asset/schedule IDs, range status, sizes, content type, timing,
and codec/index markers. Missing objects must be restored from retained originals
or backups; changing a URL cannot restore missing bytes.

To check the production API/proxy, inspect a failing video request in browser
Network tools. Verify its response is media (not an HTML login/error page), its
Range requests return 206 with a matching Content-Range, and seeking still works
after the page has been open for more than a minute. Do not share capability or
portal-session query values in logs or screenshots.

HEVC support depends on browser/device capabilities. H.264 + AAC MP4 is the more
widely compatible playback format. See the [MDN codec guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs).
For already compatible MP4 files, a fast-start remux moves the index to the front
without re-encoding:

```sh
ffmpeg -i original.mp4 -map 0 -c copy -movflags +faststart playback.mp4
```

A remux does not turn HEVC into H.264. HEVC sources need a separate H.264/AAC
playback rendition for browsers that cannot decode them. Preserve originals and
run conversion in a bounded background worker, never during a media GET or a
schedule page load. No conversion worker or mass transcoding is included in this
change. See [FFmpeg muxer documentation](https://www.ffmpeg.org/ffmpeg-formats.html).

## Server pressure

Run on the actual Linux host:

```sh
bash scripts/diagnostics/host-resources.sh
```

Compare host memory and filesystem readings with container stats and the control
center's API process RAM, heap, container usage/limit, load averages, and database
waiting connections. Load averages are not CPU utilization percentages.

The control center uses Linux MemAvailable for host RAM, deduplicates content
storage references by bucket/object key, and caches health samples for 30 seconds.
Content storage is an organization metadata estimate, while database size covers
the entire database. Neither is a measured partition of root-disk usage. Missing
readings remain unavailable. Backup/Docker/log breakdowns and historical charts
stay unavailable until measured by a host reporter. `HOST_DISK_PATH` can select
a filesystem visible to the API; the default is `/`.
