import sqlite3, json, os

db = sqlite3.connect(os.path.expanduser('~/.tradingview-mcp/db/fg.db'))
db.execute("PRAGMA journal_mode=WAL")
data_dir = '/Volumes/Ext/drillhole_data/raw'

def load_file(fname):
    path = os.path.join(data_dir, fname)
    if not os.path.exists(path): return 0
    size = os.path.getsize(path) / 1e6
    print(f"  {fname} ({size:.0f} MB)...", end='', flush=True)

    with open(path) as f:
        data = json.load(f)

    # Format: {"metadata": {...}, "data": [...]}
    records = data.get('data', data if isinstance(data, list) else [])
    if not isinstance(records, list):
        print(" not an array")
        return 0

    inserted = 0
    batch = []
    for r in records:
        batch.append((
            str(r.get('id', inserted)),
            r.get('name', ''),
            r.get('lat'),
            r.get('lon') or r.get('lng'),
            r.get('region', ''),
            r.get('country', ''),
            r.get('source', fname.replace('.json','')),
            r.get('type', 'drill_hole'),
            r.get('commodity', ''),
            r.get('depth'),
            r.get('year'),
            r.get('url', '')
        ))
        inserted += 1
        if len(batch) >= 50000:
            db.executemany("INSERT OR IGNORE INTO drillholes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", batch)
            db.commit()
            batch = []
            if inserted % 500000 == 0:
                print(f" {inserted:,}...", end='', flush=True)

    if batch:
        db.executemany("INSERT OR IGNORE INTO drillholes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", batch)
        db.commit()
    print(f" +{inserted:,}")
    return inserted

total = 0
for f in ['canada.json', 'south_australia.json', 'tasmania.json', 'greenland.json', 'south_africa.json', 'western_australia.json']:
    total += load_file(f)

print(f"\nTOTAL: {total:,}")
cur = db.execute("SELECT COUNT(*) as n, COUNT(DISTINCT country) as c, COUNT(DISTINCT commodity) as com FROM drillholes")
r = cur.fetchone()
print(f"DB: {r[0]:,} records, {r[1]} countries, {r[2]} commodities")
db.close()
