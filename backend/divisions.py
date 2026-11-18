"""Persist division labels and lifecycle independently of ownership references."""

DEFAULT_DIVISIONS = {"division-a": "Division A", "division-b": "Division B"}


def init_divisions(db):
    db.divisions.create_index("name_key", unique=True)
    for identifier, name in DEFAULT_DIVISIONS.items():
        db.divisions.update_one(
            {"_id": identifier},
            {"$setOnInsert": {"name": name, "name_key": name.casefold(), "active": True}},
            upsert=True,
        )


def serialize_division(row):
    return {"id": row["_id"], "name": row["name"], "active": row["active"]}


def division_name(db, identifier):
    row = db.divisions.find_one({"_id": identifier}, {"name": 1})
    return row["name"] if row else identifier
