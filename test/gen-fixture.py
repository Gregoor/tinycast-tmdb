import csv
src = "/Users/gregor/Downloads/TMDB_movie_dataset_v11-2.csv"
want = {"Inception", "Interstellar", "Mulholland Drive", "The Matrix", "Alien", "Alien 3",
        "Alien 3: The Assembly Cut", "Alien: Covenant", "café", "The Dark Knight", "Amélie",
        "Parasite", "Zoë"}
rows = []
with open(src, newline="", encoding="utf-8") as f:
    r = csv.DictReader(f)
    for row in r:
        if row["title"] in want:
            rows.append(row)
        if len(rows) >= 60:
            break
with open("test/fixtures/small.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
print("wrote", len(rows))
for r in rows:
    print(r["title"], "|", r["original_title"], "|", r["release_date"][:4], "|", r["popularity"], "| imdb", r["imdb_id"])