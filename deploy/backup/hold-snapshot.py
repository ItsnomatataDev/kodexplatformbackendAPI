#!/usr/bin/env python3
"""Hold one repeatable-read snapshot, export it for pg_dump, and list object references.

The reference list is not a public manifest. The caller encrypts it.
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse

REFERENCES = (
    ("tickets", "ticket_attachments", "bucket", "object_key", "TRUE", "committed"),
    ("documents", "employee_documents", "file_bucket", "file_path", "file_bucket IS NOT NULL AND file_path IS NOT NULL", "committed"),
    ("content", "client_media", "bucket", "storage_path", "storage_path IS NOT NULL", "committed"),
    ("content", "schedule_assets", "bucket", "storage_path", "storage_path IS NOT NULL", "committed"),
    ("media_platform", "assets", "origin_bucket", "origin_object_key", "status NOT IN ('deleted', 'uploading')", "committed"),
    ("media_platform", "variants", "bucket", "object_key", "status NOT IN ('deleted', 'processing')", "committed"),
    ("work", "card_attachments", "bucket", "object_key", "TRUE", "committed"),
    ("content", "upload_sessions", "bucket", "object_key", "state IS DISTINCT FROM 'completed'", "in_progress"),
    ("media_platform", "assets", "origin_bucket", "origin_object_key", "status = 'uploading'", "in_progress"),
)

ASSUMED = (
    ("organizations", "branding", "organization-branding", "logo_object_key"),
    ("organizations", "branding", "organization-branding", "favicon_object_key"),
)


def main() -> None:
    out_dir = sys.argv[1]
    env = os.environ.copy()
    env["PGOPTIONS"] = (
        (env.get("PGOPTIONS") or "")
        + " -c client_min_messages=error -c statement_timeout=0"
        + " -c idle_in_transaction_session_timeout=0"
    )
    psql_cmd = env.get("KODE_PSQL_CMD", "psql").split()
    proc = subprocess.Popen(
        psql_cmd + [
            "-h", env.get("KODE_HOLDER_PGHOST", env["PGHOST"]),
            "-p", env.get("KODE_HOLDER_PGPORT", env["PGPORT"]),
            "-U", env["PGUSER"],
            "-d", env["PGDATABASE"],
            "-X", "-q", "-v", "ON_ERROR_STOP=1",
            "-A", "-t", "--no-psqlrc",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )

    def query(sql: str) -> list[str]:
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(sql.strip() + ";\nSELECT 'KODESENTINEL';\n")
        proc.stdin.flush()
        rows: list[str] = []
        while True:
            line = proc.stdout.readline()
            if line == "":
                err = proc.stderr.read() if proc.stderr is not None else ""
                raise SystemExit(f"snapshot session closed: {err.strip()}")
            line = line.rstrip("\n")
            if line == "KODESENTINEL":
                return rows
            if line:
                rows.append(line)

    def exists(schema: str, table: str) -> bool:
        rows = query(f"SELECT to_regclass('{schema}.{table}') IS NOT NULL")
        return rows == ["t"]

    query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    query("SET LOCAL statement_timeout = 0")
    query("SET LOCAL idle_in_transaction_session_timeout = 0")
    snapshot = query("SELECT pg_export_snapshot()")
    if len(snapshot) != 1 or not snapshot[0]:
        raise SystemExit("snapshot export returned no id")

    references = []
    for schema, table, bucket, key, where, kind in REFERENCES:
        if not exists(schema, table):
            continue
        rows = query(
            "SELECT row_to_json(t)::text FROM ("
            f"SELECT {bucket} AS bucket, {key} AS object_key "
            f"FROM {schema}.{table} WHERE {where}"
            ") t"
        )
        for row in rows:
            item = json.loads(row)
            if not item.get("bucket") or not item.get("object_key"):
                references.append({"class": "unparsed", "relation": f"{schema}.{table}"})
                continue
            references.append({
                "class": kind,
                "bucket": item["bucket"],
                "key": item["object_key"],
                "relation": f"{schema}.{table}",
            })

    for schema, table, bucket, column in ASSUMED:
        if not exists(schema, table):
            continue
        rows = query(
            "SELECT row_to_json(t)::text FROM ("
            f"SELECT {column} AS object_key FROM {schema}.{table} "
            f"WHERE {column} IS NOT NULL"
            ") t"
        )
        for row in rows:
            item = json.loads(row)
            references.append({
                "class": "committed",
                "bucket": bucket,
                "key": item["object_key"],
                "relation": f"{schema}.{table}",
                "bucket_assumed": True,
            })

    if exists("chat", "messages"):
        columns = query(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = 'chat' AND table_name = 'messages' "
            "AND column_name = 'attachment_url'"
        )
        if columns:
            for row in query(
                "SELECT attachment_url FROM chat.messages "
                "WHERE attachment_url IS NOT NULL"
            ):
                parsed = parse_chat_url(row)
                if parsed is None:
                    references.append({"class": "unparsed", "relation": "chat.messages"})
                else:
                    references.append({
                        "class": "committed",
                        "bucket": parsed[0],
                        "key": parsed[1],
                        "relation": "chat.messages",
                    })

    with open(os.path.join(out_dir, "snapshot.id"), "w", encoding="utf-8") as handle:
        handle.write(snapshot[0] + "\n")
    with open(os.path.join(out_dir, "references.ndjson"), "w", encoding="utf-8") as handle:
        for item in references:
            handle.write(json.dumps(item, separators=(",", ":")) + "\n")
    open(os.path.join(out_dir, "snapshot.ready"), "w", encoding="utf-8").close()

    release = os.path.join(out_dir, "snapshot.release")
    deadline = time.time() + 6 * 60 * 60
    while not os.path.exists(release):
        if time.time() > deadline:
            break
        if proc.poll() is not None:
            raise SystemExit("snapshot session ended before release")
        time.sleep(0.2)
    query("COMMIT")
    proc.stdin.close()
    proc.wait(timeout=30)


def parse_chat_url(url: str):
    if "/api/chat/media?" in url:
        parsed = urllib.parse.urlparse(url)
        params = urllib.parse.parse_qs(parsed.query)
        bucket = params.get("bucket", [None])[0]
        key = params.get("objectKey", [None])[0]
        if bucket and key:
            return urllib.parse.unquote(bucket), urllib.parse.unquote(key)
        return None
    marker = "/api/chat/media/"
    if marker not in url:
        return None
    rest = url.split(marker, 1)[1]
    bucket, separator, key = rest.partition("/")
    if not separator or bucket not in {"chat-images", "chat-attachments"} or not key:
        return None
    return bucket, urllib.parse.unquote(key)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise
