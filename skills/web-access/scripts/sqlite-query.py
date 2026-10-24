import sqlite3
import sys

# The registered Node caller decodes UTF-8 even on a GBK Windows host.
if sys.stdout is not None:
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: sqlite-query.py <database> <sql>", file=sys.stderr)
        return 2

    database, sql = sys.argv[1], sys.argv[2]
    conn = sqlite3.connect(database)
    try:
        for row in conn.execute(sql):
            print("\t".join("" if value is None else str(value) for value in row))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
