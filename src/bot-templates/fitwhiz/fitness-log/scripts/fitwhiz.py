#!/usr/bin/env python3
"""FitWhiz log: the coach's record of a person's profile, targets, meals, workouts and weigh-ins.

Standard library only. Data lives in fitwhiz.db next to this script (or in $FITWHIZ_HOME),
and the Indian food table is read from indian-foods.csv in the same folder.
Run `python3 fitwhiz.py --help` or `python3 fitwhiz.py <command> --help` for usage.
"""

import argparse
import csv
import json
import os
import re
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

VERSION = "1"
HOME = Path(os.environ.get("FITWHIZ_HOME") or Path(__file__).resolve().parent)
FOODS = HOME / "indian-foods.csv"

ACTIVITY = {"sedentary": 1.2, "light": 1.375, "moderate": 1.55, "very_active": 1.725}
# Mifflin-St Jeor's sex term; "unspecified" uses the midpoint of the two.
SEX_TERM = {"male": 5, "female": -161, "unspecified": -78}
GOALS = ("lose", "maintain", "gain")
DEFAULT_WEEKLY_CHANGE = {"lose": 0.5, "maintain": 0.0, "gain": 0.25}
MAX_WEEKLY_CHANGE = 0.5
KCAL_PER_KG = 7700
MIN_CALORIES = 1200
MEAL_TYPES = ("breakfast", "lunch", "dinner", "snack")
KINDS = {"m": "meals", "w": "workouts", "b": "weigh_ins"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS profile (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, source TEXT NOT NULL,
  calories INTEGER NOT NULL, protein_g INTEGER NOT NULL, carbs_g INTEGER NOT NULL, fat_g INTEGER NOT NULL,
  bmr INTEGER, maintenance INTEGER, weekly_change_kg REAL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, meal_type TEXT, name TEXT NOT NULL,
  quantity TEXT, food_id TEXT, source TEXT NOT NULL,
  kcal REAL NOT NULL, protein_g REAL, carbs_g REAL, fat_g REAL, fiber_g REAL,
  voided INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workouts (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, name TEXT NOT NULL,
  duration_min REAL, notes TEXT, voided INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workout_sets (
  workout_id INTEGER NOT NULL REFERENCES workouts(id), position INTEGER NOT NULL, exercise TEXT NOT NULL,
  spec TEXT, sets INTEGER, reps INTEGER, weight_kg REAL, duration_s INTEGER);
CREATE TABLE IF NOT EXISTS weigh_ins (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, weight_kg REAL NOT NULL,
  waist_cm REAL, body_fat_pct REAL, voided INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
"""


class Problem(Exception):
    """A mistake in the request, reported without a traceback."""


def connect():
    HOME.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(HOME / "fitwhiz.db")
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


def now_utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# Profile and time zone

PROFILE_FIELDS = ("age", "sex", "height_cm", "weight_kg", "activity", "goal", "goal_weight_kg",
                  "weekly_change_kg", "timezone", "diet", "allergies", "injuries", "equipment", "notes")


def read_profile(db):
    return {row["key"]: json.loads(row["value"]) for row in db.execute("SELECT key, value FROM profile")}


def parse_timezone(name):
    match = re.fullmatch(r"(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?", name.strip(), re.I)
    if match:
        sign, hours, minutes = match.groups()
        offset = timedelta(hours=int(hours), minutes=int(minutes or 0))
        return timezone(-offset if sign == "-" else offset)
    if name.strip().upper() in ("UTC", "GMT", "Z"):
        return timezone.utc
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name.strip())
    except Exception:
        raise Problem(f"Unknown time zone {name!r}. Use a name like Asia/Kolkata or an offset like +05:30.")


def user_zone(profile):
    return parse_timezone(profile["timezone"]) if profile.get("timezone") else timezone.utc


def zone_label(profile):
    return profile.get("timezone") or "UTC (no time zone saved)"


def local_now(profile):
    return datetime.now(user_zone(profile))


def parse_when(text, profile):
    """Accepts HH:MM, YYYY-MM-DD, YYYY-MM-DD HH:MM, 'yesterday' or 'yesterday HH:MM', in the user's time zone."""
    zone = user_zone(profile)
    current = datetime.now(zone)
    if not text:
        return current
    value = text.strip().lower()
    base = current.date()
    if value.startswith("yesterday"):
        base -= timedelta(days=1)
        value = value[len("yesterday"):].strip() or "12:00"
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2})(?:[ t](\d{1,2}:\d{2}))?", value)
    if match:
        base = date.fromisoformat(match.group(1))
        value = match.group(2) or "12:00"
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", value)
    if not match:
        raise Problem(f"Can't read the time {text!r}. Use HH:MM, YYYY-MM-DD, 'YYYY-MM-DD HH:MM' or 'yesterday HH:MM'.")
    hour, minute = int(match.group(1)), int(match.group(2))
    if hour > 23 or minute > 59:
        raise Problem(f"Can't read the time {text!r}.")
    return datetime(base.year, base.month, base.day, hour, minute, tzinfo=zone)


def parse_day(text, profile):
    if not text:
        return local_now(profile).date()
    if text.strip().lower() == "yesterday":
        return local_now(profile).date() - timedelta(days=1)
    try:
        return date.fromisoformat(text.strip())
    except ValueError:
        raise Problem(f"Can't read the date {text!r}. Use YYYY-MM-DD.")


def cmd_profile(db, args):
    profile = read_profile(db)
    if args.action == "set":
        updates = {field: getattr(args, field) for field in PROFILE_FIELDS if getattr(args, field) is not None}
        if not updates:
            raise Problem("Pass at least one field to set, such as --weight-kg 80.")
        if "timezone" in updates:
            parse_timezone(updates["timezone"])
        if "age" in updates and not 18 <= updates["age"] <= 100:
            raise Problem("FitWhiz targets are for adults aged 18 to 100. For anyone younger, suggest a doctor or registered dietitian.")
        for field in ("goal_weight_kg", "weight_kg"):
            if field in updates and not 30 <= updates[field] <= 350:
                raise Problem(f"{field} must be between 30 and 350 kg.")
        if "height_cm" in updates and not 100 <= updates["height_cm"] <= 250:
            raise Problem("height_cm must be between 100 and 250.")
        if "weekly_change_kg" in updates:
            updates["weekly_change_kg"] = abs(updates["weekly_change_kg"])
        for key, value in updates.items():
            db.execute("INSERT INTO profile (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                       (key, json.dumps(value)))
        db.commit()
        profile = read_profile(db)
        print("Saved: " + ", ".join(updates))
    if not profile:
        print("No profile saved yet.")
        return
    for field in PROFILE_FIELDS:
        if field in profile:
            print(f"{field}: {profile[field]}")
    missing = [field for field in ("age", "sex", "height_cm", "weight_kg", "activity", "goal") if field not in profile]
    if missing:
        print("Still needed for targets: " + ", ".join(missing))
    if "weight_kg" in profile and "height_cm" in profile:
        print(body_summary(profile["weight_kg"], profile["height_cm"]))


def body_summary(weight, height):
    metres = height / 100
    low, high = 18.5 * metres ** 2, 24.9 * metres ** 2
    return f"BMI {weight / metres ** 2:.1f}; a BMI of 18.5 to 24.9 at this height is {low:.0f} to {high:.0f} kg."


# Targets

def split_macros(calories, weight, goal):
    protein = round((1.6 if goal == "maintain" else 1.8) * weight)
    fat = round(calories * (0.30 if goal == "maintain" else 0.25) / 9)
    carbs = max(0, round((calories - protein * 4 - fat * 9) / 4))
    return protein, carbs, fat


def compute_targets(profile):
    missing = [field for field in ("age", "sex", "height_cm", "weight_kg", "activity", "goal") if field not in profile]
    if missing:
        raise Problem("Save these in the profile first: " + ", ".join(missing))
    weight, goal = profile["weight_kg"], profile["goal"]
    bmr = 10 * weight + 6.25 * profile["height_cm"] - 5 * profile["age"] + SEX_TERM[profile["sex"]]
    maintenance = bmr * ACTIVITY[profile["activity"]]
    change = 0.0 if goal == "maintain" else min(profile.get("weekly_change_kg", DEFAULT_WEEKLY_CHANGE[goal]), MAX_WEEKLY_CHANGE)
    signed = -change if goal == "lose" else change
    calories = round(maintenance + signed * KCAL_PER_KG / 7)
    notes = []
    if profile.get("weekly_change_kg", 0) > MAX_WEEKLY_CHANGE:
        notes.append(f"Weekly change capped at {MAX_WEEKLY_CHANGE} kg.")
    if calories < MIN_CALORIES:
        notes.append(f"Raised to the {MIN_CALORIES} kcal floor; going lower needs a clinician.")
        calories = MIN_CALORIES
    protein, carbs, fat = split_macros(calories, weight, goal)
    return {"calories": calories, "protein_g": protein, "carbs_g": carbs, "fat_g": fat, "bmr": round(bmr),
            "maintenance": round(maintenance), "weekly_change_kg": signed}, notes


def active_targets(db):
    return db.execute("SELECT * FROM targets WHERE active = 1 ORDER BY id DESC LIMIT 1").fetchone()


def save_targets(db, values, source):
    db.execute("UPDATE targets SET active = 0 WHERE active = 1")
    db.execute("INSERT INTO targets (created_at, source, calories, protein_g, carbs_g, fat_g, bmr, maintenance, weekly_change_kg) "
               "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
               (now_utc(), source, values["calories"], values["protein_g"], values["carbs_g"], values["fat_g"],
                values.get("bmr"), values.get("maintenance"), values.get("weekly_change_kg")))
    db.commit()


def print_targets(row):
    print(f"Daily target: {row['calories']} kcal, protein {row['protein_g']} g, carbs {row['carbs_g']} g, fat {row['fat_g']} g "
          f"({row['source']}, set {row['created_at'][:10]})")
    if row["maintenance"]:
        change = row["weekly_change_kg"] or 0
        trend = "maintain weight" if not change else f"{change:+.2f} kg per week"
        print(f"BMR {row['bmr']} kcal, maintenance {row['maintenance']} kcal, aiming to {trend}.")


def cmd_targets(db, args):
    if args.action == "set":
        profile = read_profile(db)
        manual = [args.calories, args.protein_g, args.carbs_g, args.fat_g]
        if all(value is None for value in manual):
            values, notes = compute_targets(profile)
            save_targets(db, values, "computed")
        else:
            current = active_targets(db)
            calories = args.calories or (current["calories"] if current else None)
            if calories is None:
                raise Problem("Pass --calories, or set targets from the profile first.")
            if calories < MIN_CALORIES:
                raise Problem(f"Targets under {MIN_CALORIES} kcal need a clinician's supervision. Nothing was saved.")
            weight = profile.get("weight_kg")
            if weight is None and None in (args.protein_g, args.carbs_g, args.fat_g):
                raise Problem("Save weight_kg in the profile, or pass all of --protein-g, --carbs-g and --fat-g.")
            protein, carbs, fat = split_macros(calories, weight, profile.get("goal", "maintain")) if weight else (0, 0, 0)
            protein = args.protein_g if args.protein_g is not None else protein
            fat = args.fat_g if args.fat_g is not None else fat
            carbs = args.carbs_g if args.carbs_g is not None else max(0, round((calories - protein * 4 - fat * 9) / 4))
            values, notes = {"calories": calories, "protein_g": protein, "carbs_g": carbs, "fat_g": fat}, []
            save_targets(db, values, "manual")
        for note in notes:
            print(note)
    row = active_targets(db)
    if not row:
        print("No targets yet. Run `targets set` once the profile is complete.")
        return
    print_targets(row)


# Foods

def load_foods():
    if not FOODS.exists():
        raise Problem(f"{FOODS.name} is missing. Copy it from the fitness-log skill next to this script.")
    with FOODS.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def number(value):
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


def describe_food(food):
    per_serving = (f"{food['serving_description']} ({food['serving_weight_g']} g): {food['energy_kcal_per_serving']} kcal, "
                   f"P {food['protein_g_per_serving']} C {food['carbohydrate_g_per_serving']} F {food['total_fat_g_per_serving']}")
    per_100 = (f"per 100 g: {food['energy_kcal_per_100g']} kcal, P {food['protein_g_per_100g']} C {food['carbohydrate_g_per_100g']} "
               f"F {food['total_fat_g_per_100g']} fibre {food['fiber_g_per_100g'] or 'n/a'}")
    return per_serving, per_100


def cmd_foods(db, args):
    foods = load_foods()
    words = [word for word in re.split(r"\W+", (args.query or "").lower()) if word]
    matches = [food for food in foods
               if all(word in " ".join([food["id"], food["name"], food["alternate_names"], food["category"]]).lower().replace("_", " ")
                      or word in food["id"] for word in words)]
    if not matches:
        print(f"No foods match {args.query!r}. Estimate it instead and log with --kcal and the macros.")
        return
    for food in matches[:25]:
        per_serving, per_100 = describe_food(food)
        print(f"{food['id']}: {food['name']} [{food['dietary_tags'] or 'no tags'}; {food['confidence']} confidence]")
        print(f"  {per_serving}; {per_100}")
    if len(matches) > 25:
        print(f"...and {len(matches) - 25} more; narrow the search.")


def find_food(food_id):
    for food in load_foods():
        if food["id"] == food_id:
            return food
    raise Problem(f"No food with id {food_id!r}. Search with `foods <words>`.")


# Logging

def entry_time(args, profile):
    when = parse_when(args.at, profile)
    return when.isoformat(timespec="minutes"), when.date().isoformat()


def cmd_meal(db, args):
    profile = read_profile(db)
    if args.type and args.type not in MEAL_TYPES:
        raise Problem("--type must be one of " + ", ".join(MEAL_TYPES))
    if args.food:
        if args.kcal is not None:
            raise Problem("Use either --food with --servings or --grams, or --kcal with estimated macros, not both.")
        food = find_food(args.food)
        if args.grams is not None:
            factor, unit = args.grams / 100, "100g"
            quantity = args.quantity or f"{args.grams:g} g"
        else:
            servings = args.servings if args.servings is not None else 1
            factor, unit = servings, "serving"
            quantity = args.quantity or (food["serving_description"] if servings == 1 else f"{servings:g} x {food['serving_description']}")
        value = lambda key: None if number(food[f"{key}_per_{unit}"]) is None else number(food[f"{key}_per_{unit}"]) * factor
        if unit == "serving":
            # The table has no fibre per serving; derive it from the serving weight.
            fiber_100, weight = number(food["fiber_g_per_100g"]), number(food["serving_weight_g"])
            fiber = fiber_100 * weight / 100 * factor if fiber_100 is not None and weight else None
        else:
            fiber = value("fiber_g")
        nutrition = (value("energy_kcal"), value("protein_g"), value("carbohydrate_g"), value("total_fat_g"), fiber)
        name, food_id, source = args.name or food["name"], food["id"], "table"
    else:
        if args.kcal is None or not args.name:
            raise Problem("Pass --food <id>, or --name with --kcal and the estimated --protein, --carbs and --fat.")
        nutrition = (args.kcal, args.protein, args.carbs, args.fat, args.fiber)
        name, food_id, source, quantity = args.name, None, "estimate", args.quantity
    if nutrition[0] is None or nutrition[0] < 0 or nutrition[0] > 5000:
        raise Problem("Calories for one entry must be between 0 and 5000.")
    at, day = entry_time(args, profile)
    cursor = db.execute(
        "INSERT INTO meals (at, day, meal_type, name, quantity, food_id, source, kcal, protein_g, carbs_g, fat_g, fiber_g, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (at, day, args.type, name, quantity, food_id, source, *nutrition, now_utc()))
    db.commit()
    row = db.execute("SELECT * FROM meals WHERE id = ?", (cursor.lastrowid,)).fetchone()
    print("Logged " + meal_line(row))
    print_day_totals(db, profile, date.fromisoformat(day))


EXERCISE = re.compile(r"(?:(?P<sets>\d+)\s*[x×]\s*(?P<reps>\d+)(?P<secs>\s*s(?:ec)?\b)?)?\s*"
                      r"(?:@\s*(?P<weight>\d+(?:\.\d+)?)\s*(?P<unit>kg|lbs?)?)?\s*"
                      r"(?:(?P<minutes>\d+(?:\.\d+)?)\s*min)?", re.I)


def parse_exercise(text):
    name, _, spec = text.partition(":")
    if not name.strip():
        raise Problem(f"Exercise {text!r} needs a name, like 'Squat: 5x5 @ 80kg'.")
    spec = spec.strip()
    match = EXERCISE.fullmatch(spec) if spec else None
    sets = reps = weight = duration = None
    if match:
        if match["sets"]:
            sets = int(match["sets"])
            if match["secs"]:
                duration = int(match["reps"])
            else:
                reps = int(match["reps"])
        if match["weight"]:
            weight = float(match["weight"]) * (0.4536 if (match["unit"] or "kg").lower().startswith("lb") else 1)
        if match["minutes"]:
            duration = round(float(match["minutes"]) * 60)
    return name.strip(), spec or None, sets, reps, weight, duration


def cmd_workout(db, args):
    profile = read_profile(db)
    exercises = [parse_exercise(text) for text in args.exercise or []]
    at, day = entry_time(args, profile)
    cursor = db.execute("INSERT INTO workouts (at, day, name, duration_min, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (at, day, args.name, args.duration_min, args.notes, now_utc()))
    for position, exercise in enumerate(exercises):
        db.execute("INSERT INTO workout_sets (workout_id, position, exercise, spec, sets, reps, weight_kg, duration_s) "
                   "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (cursor.lastrowid, position, *exercise))
    db.commit()
    row = db.execute("SELECT * FROM workouts WHERE id = ?", (cursor.lastrowid,)).fetchone()
    print("Logged " + workout_line(db, row))


def cmd_weigh(db, args):
    profile = read_profile(db)
    if not 30 <= args.kg <= 350:
        raise Problem("Weight must be between 30 and 350 kg.")
    at, day = entry_time(args, profile)
    cursor = db.execute("INSERT INTO weigh_ins (at, day, weight_kg, waist_cm, body_fat_pct, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (at, day, args.kg, args.waist_cm, args.body_fat, now_utc()))
    db.commit()
    row = db.execute("SELECT * FROM weigh_ins WHERE id = ?", (cursor.lastrowid,)).fetchone()
    print("Logged " + weigh_line(row))
    if profile.get("weight_kg") != args.kg:
        print(f"Profile weight is {profile.get('weight_kg', 'not set')} kg. Update it with `profile set --weight-kg {args.kg:g}` "
              "if this is the new normal, then `targets set` to recompute.")


def cmd_void(db, args, voided=1):
    match = re.fullmatch(r"([mwb])(\d+)", args.id.strip().lower())
    if not match:
        raise Problem("Entry IDs look like m12 (meal), w3 (workout) or b4 (weigh-in).")
    table = KINDS[match.group(1)]
    row = db.execute(f"SELECT * FROM {table} WHERE id = ?", (int(match.group(2)),)).fetchone()
    if not row:
        raise Problem(f"No entry {args.id}.")
    db.execute(f"UPDATE {table} SET voided = ? WHERE id = ?", (voided, row["id"]))
    db.commit()
    row = db.execute(f"SELECT * FROM {table} WHERE id = ?", (row["id"],)).fetchone()
    line = {"meals": meal_line, "weigh_ins": weigh_line}.get(table)
    print(("Voided " if voided else "Restored ") + (line(row) if line else workout_line(db, row)))


# Reports

def grams(value):
    if value is None:
        return "?"
    return f"{value:.1f}" if abs(value) < 10 else f"{value:.0f}"


def meal_line(row):
    quantity = f", {row['quantity']}" if row["quantity"] else ""
    label = f"{row['meal_type']} " if row["meal_type"] else ""
    flag = " [voided]" if row["voided"] else ""
    return (f"m{row['id']} {row['at'][11:16]} {label}{row['name']}{quantity}: {row['kcal']:.0f} kcal, "
            f"P {grams(row['protein_g'])} C {grams(row['carbs_g'])} F {grams(row['fat_g'])} ({row['source']}){flag}")


def workout_line(db, row):
    sets = db.execute("SELECT exercise, spec FROM workout_sets WHERE workout_id = ? ORDER BY position", (row["id"],)).fetchall()
    duration = f" ({row['duration_min']:g} min)" if row["duration_min"] else ""
    detail = "; ".join(f"{item['exercise']} {item['spec'] or ''}".strip() for item in sets)
    notes = f". Notes: {row['notes']}" if row["notes"] else ""
    flag = " [voided]" if row["voided"] else ""
    return f"w{row['id']} {row['at'][11:16]} {row['name']}{duration}{': ' + detail if detail else ''}{notes}{flag}"


def weigh_line(row):
    extra = "".join([f", waist {row['waist_cm']:g} cm" if row["waist_cm"] else "",
                     f", body fat {row['body_fat_pct']:g}%" if row["body_fat_pct"] else ""])
    flag = " [voided]" if row["voided"] else ""
    return f"b{row['id']} {row['day']} {row['at'][11:16]} {row['weight_kg']:g} kg{extra}{flag}"


def totals(db, first, last):
    return db.execute("SELECT day, COUNT(*) AS meals, SUM(kcal) AS kcal, SUM(protein_g) AS protein, SUM(carbs_g) AS carbs, "
                      "SUM(fat_g) AS fat FROM meals WHERE voided = 0 AND day BETWEEN ? AND ? GROUP BY day",
                      (first.isoformat(), last.isoformat())).fetchall()


def print_day_totals(db, profile, day):
    row = next(iter(totals(db, day, day)), None)
    eaten = (row["kcal"] or 0, row["protein"] or 0, row["carbs"] or 0, row["fat"] or 0) if row else (0, 0, 0, 0)
    target = active_targets(db)
    print(f"{day.strftime('%a %d %b %Y')} so far: {eaten[0]:.0f} kcal, P {eaten[1]:.0f} C {eaten[2]:.0f} F {eaten[3]:.0f}")
    if target:
        left = (target["calories"] - eaten[0], target["protein_g"] - eaten[1], target["carbs_g"] - eaten[2], target["fat_g"] - eaten[3])
        print(f"Left against target: {left[0]:.0f} kcal, P {left[1]:.0f} C {left[2]:.0f} F {left[3]:.0f}")


def cmd_today(db, args):
    profile = read_profile(db)
    day = parse_day(args.date, profile)
    print(f"{day.isoformat()} ({zone_label(profile)})")
    target = active_targets(db)
    if target:
        print_targets(target)
    else:
        print("No targets set.")
    print_day_totals(db, profile, day)
    meals = db.execute("SELECT * FROM meals WHERE voided = 0 AND day = ? ORDER BY at, id", (day.isoformat(),)).fetchall()
    workouts = db.execute("SELECT * FROM workouts WHERE voided = 0 AND day = ? ORDER BY at, id", (day.isoformat(),)).fetchall()
    weighs = db.execute("SELECT * FROM weigh_ins WHERE voided = 0 AND day = ? ORDER BY at, id", (day.isoformat(),)).fetchall()
    print("Meals:" if meals else "Meals: none logged")
    for row in meals:
        print("  " + meal_line(row))
    print("Workouts:" if workouts else "Workouts: none logged")
    for row in workouts:
        print("  " + workout_line(db, row))
    for row in weighs:
        print("Weigh-in: " + weigh_line(row))


def cmd_week(db, args):
    profile = read_profile(db)
    last = parse_day(args.end, profile)
    first = last - timedelta(days=args.days - 1)
    by_day = {row["day"]: row for row in totals(db, first, last)}
    workouts = db.execute("SELECT * FROM workouts WHERE voided = 0 AND day BETWEEN ? AND ? ORDER BY at",
                          (first.isoformat(), last.isoformat())).fetchall()
    target = active_targets(db)
    print(f"{first.isoformat()} to {last.isoformat()} ({zone_label(profile)})")
    if target:
        print_targets(target)
    logged = []
    for offset in range(args.days):
        day = (first + timedelta(days=offset)).isoformat()
        row = by_day.get(day)
        names = ", ".join(item["name"] for item in workouts if item["day"] == day)
        if row:
            logged.append(row)
            entries = f"{row['meals']} {'entry' if row['meals'] == 1 else 'entries'}"
            food = f"{row['kcal']:.0f} kcal, P {row['protein'] or 0:.0f} C {row['carbs'] or 0:.0f} F {row['fat'] or 0:.0f} ({entries})"
        else:
            food = "no meals logged"
        print(f"  {day} {date.fromisoformat(day).strftime('%a')}: {food}{'; workout: ' + names if names else ''}")
    if logged:
        average = sum(row["kcal"] for row in logged) / len(logged)
        protein = sum(row["protein"] or 0 for row in logged) / len(logged)
        line = f"Average on the {len(logged)} logged days: {average:.0f} kcal, protein {protein:.0f} g"
        if target:
            close = sum(1 for row in logged if abs(row["kcal"] - target["calories"]) <= 0.1 * target["calories"])
            line += f" (target {target['calories']} kcal and {target['protein_g']} g; {close} days within 10% of calories)"
        print(line)
        print("Days with only a few entries may be incomplete logs rather than low intake.")
    print(f"Workouts: {len(workouts)}")
    weighs = db.execute("SELECT * FROM weigh_ins WHERE voided = 0 AND day BETWEEN ? AND ? ORDER BY at",
                        (first.isoformat(), last.isoformat())).fetchall()
    if len(weighs) >= 2:
        change = weighs[-1]["weight_kg"] - weighs[0]["weight_kg"]
        print(f"Weight: {weighs[0]['weight_kg']:g} kg on {weighs[0]['day']} to {weighs[-1]['weight_kg']:g} kg on {weighs[-1]['day']} "
              f"({change:+.1f} kg over {len(weighs)} weigh-ins)")
    elif weighs:
        print(f"Weight: one weigh-in, {weighs[0]['weight_kg']:g} kg on {weighs[0]['day']}")
    else:
        print("Weight: no weigh-ins")


def cmd_log(db, args):
    profile = read_profile(db)
    last = local_now(profile).date()
    first = (last - timedelta(days=args.days - 1)).isoformat()
    voided = "" if args.voided else "AND voided = 0"
    entries = [(row["at"], meal_line(row)) for row in db.execute(f"SELECT * FROM meals WHERE day >= ? {voided}", (first,))]
    entries += [(row["at"], workout_line(db, row)) for row in db.execute(f"SELECT * FROM workouts WHERE day >= ? {voided}", (first,))]
    entries += [(row["at"], weigh_line(row)) for row in db.execute(f"SELECT * FROM weigh_ins WHERE day >= ? {voided}", (first,))]
    if not entries:
        print(f"Nothing logged in the last {args.days} days.")
    for at, line in sorted(entries):
        print(f"{at[:10]} {line}")


def build_parser():
    parser = argparse.ArgumentParser(prog="fitwhiz.py", description="FitWhiz coaching log.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version", help="Print the script version.")

    profile = commands.add_parser("profile", help="Show or update the person's profile.")
    profile.add_argument("action", nargs="?", choices=["show", "set"], default="show")
    profile.add_argument("--age", type=int)
    profile.add_argument("--sex", choices=sorted(SEX_TERM), help="For the calorie formula only.")
    profile.add_argument("--height-cm", type=float)
    profile.add_argument("--weight-kg", type=float)
    profile.add_argument("--activity", choices=list(ACTIVITY))
    profile.add_argument("--goal", choices=GOALS)
    profile.add_argument("--goal-weight-kg", type=float)
    profile.add_argument("--weekly-change-kg", type=float, help=f"Target loss or gain per week, up to {MAX_WEEKLY_CHANGE}.")
    profile.add_argument("--timezone", help="IANA name such as Asia/Kolkata, or an offset like +05:30.")
    profile.add_argument("--diet", help="For example vegetarian, eggetarian, non-vegetarian, vegan.")
    profile.add_argument("--allergies")
    profile.add_argument("--injuries")
    profile.add_argument("--equipment")
    profile.add_argument("--notes")

    targets = commands.add_parser("targets", help="Show targets, or set them from the profile or by hand.")
    targets.add_argument("action", nargs="?", choices=["show", "set"], default="show")
    targets.add_argument("--calories", type=int)
    targets.add_argument("--protein-g", type=int)
    targets.add_argument("--carbs-g", type=int)
    targets.add_argument("--fat-g", type=int)

    foods = commands.add_parser("foods", help="Search the Indian food table.")
    foods.add_argument("query", nargs="?", default="")

    meal = commands.add_parser("meal", help="Log something eaten.")
    meal.add_argument("--name")
    meal.add_argument("--food", help="Food id from `foods`.")
    meal.add_argument("--servings", type=float, help="Servings of the table's standard serving.")
    meal.add_argument("--grams", type=float)
    meal.add_argument("--quantity", help="How the person described the amount, e.g. '2 rotis'.")
    meal.add_argument("--kcal", type=float)
    meal.add_argument("--protein", type=float)
    meal.add_argument("--carbs", type=float)
    meal.add_argument("--fat", type=float)
    meal.add_argument("--fiber", type=float)
    meal.add_argument("--type", help="breakfast, lunch, dinner or snack.")
    meal.add_argument("--at", help="HH:MM, YYYY-MM-DD, 'YYYY-MM-DD HH:MM' or 'yesterday HH:MM' in the person's time zone.")

    workout = commands.add_parser("workout", help="Log a workout.")
    workout.add_argument("--name", required=True)
    workout.add_argument("--exercise", action="append", help="Repeatable, e.g. 'Squat: 5x5 @ 80kg', 'Plank: 3x45s', 'Run: 30 min'.")
    workout.add_argument("--duration-min", type=float)
    workout.add_argument("--notes")
    workout.add_argument("--at")

    weigh = commands.add_parser("weigh", help="Log a weigh-in.")
    weigh.add_argument("--kg", type=float, required=True)
    weigh.add_argument("--waist-cm", type=float)
    weigh.add_argument("--body-fat", type=float)
    weigh.add_argument("--at")

    today = commands.add_parser("today", help="One day's targets, totals and entries.")
    today.add_argument("--date", help="YYYY-MM-DD or 'yesterday'; defaults to today.")

    week = commands.add_parser("week", help="Daily totals, averages, workouts and weight trend.")
    week.add_argument("--end", help="Last day, YYYY-MM-DD; defaults to today.")
    week.add_argument("--days", type=int, default=7)

    log = commands.add_parser("log", help="List recent entries with their IDs.")
    log.add_argument("--days", type=int, default=7)
    log.add_argument("--voided", action="store_true", help="Include voided entries.")

    for name, help_text in (("void", "Mark a mistaken entry as void."), ("restore", "Undo a void.")):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("id", help="Entry ID such as m12, w3 or b4.")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "version":
        print(VERSION)
        return 0
    handlers = {"profile": cmd_profile, "targets": cmd_targets, "foods": cmd_foods, "meal": cmd_meal, "workout": cmd_workout,
                "weigh": cmd_weigh, "today": cmd_today, "week": cmd_week, "log": cmd_log, "void": cmd_void,
                "restore": lambda db, a: cmd_void(db, a, voided=0)}
    db = connect()
    try:
        handlers[args.command](db, args)
    except Problem as problem:
        print(f"Error: {problem}", file=sys.stderr)
        return 2
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
