---
name: fitness-log
description: Keep the person's fitness log on your computer, covering profile, calorie and macro targets, meals, workouts and weigh-ins, and look up Indian foods in the nutrition table. Use whenever they tell you what they ate or did, weigh in, ask about today's or this week's numbers, or want targets set or changed.
---

# Fitness log

The log is a small SQLite database run by `fitwhiz/fitwhiz.py` in your workspace. It is the only record of the person's meals, workouts, weigh-ins and targets, so write every entry through it, and read numbers from it instead of from memory or the conversation.

Every path here is relative to your workspace, the folder commands start in. Run the commands below as written, without changing directory first, and pass the same relative paths when copying.

## Setup, once per computer

Run `python3 fitwhiz/fitwhiz.py version`. If it doesn't print `1`, copy this skill's files with copy_skill_file to exactly these paths, then run `version` again:

- `scripts/fitwhiz.py` to `fitwhiz/fitwhiz.py`
- `data/indian-foods.csv` to `fitwhiz/indian-foods.csv`

Copying never touches `fitwhiz/fitwhiz.db`, so existing logs survive an update. `python3 fitwhiz/fitwhiz.py <command> --help` lists every option.

## Profile and targets

- `profile set --age 29 --sex male --height-cm 178 --weight-kg 82 --activity moderate --goal lose --goal-weight-kg 75 --timezone Asia/Kolkata --diet vegetarian`. Pass only the fields you learned; `profile` shows what is saved and what is still needed.
- `--sex` is male, female or unspecified, and only feeds the calorie formula. `--activity` is sedentary (desk job, little exercise), light (1 to 3 sessions a week), moderate (3 to 5) or very_active (6 or more, or a physical job).
- `--weekly-change-kg` is the loss or gain per week. It defaults to 0.5 for lose and 0.25 for gain, and anything above 0.5 is capped.
- Always save `--timezone`. Every date and time in the log is in it, and without one the log uses UTC.
- `targets set` with no numbers works out targets from the profile: Mifflin-St Jeor BMR, times the activity factor, plus or minus 7,700 kcal per kg of weekly change, never below 1,200 kcal. Protein is 1.8 g per kg to lose or gain and 1.6 to maintain, fat is 25% or 30% of calories, and carbs are the rest. Run it again after the goal, activity or a lasting weight change.
- `targets set --calories 2100 [--protein-g 150]` saves targets by hand when the person or their dietitian sets them; omitted macros are filled in. The script refuses anything under 1,200 kcal.

## Logging food

1. Work out each item and its amount from what the person said. If an amount is unclear and changes the numbers a lot, such as "some rice", ask once. Never ask them for calories.
2. For Indian dishes, `foods <words>` searches the table, such as `foods paneer` or `foods dosa`. When it has the dish, log with `meal --food <id> --servings 2` or `--grams 180`, and the nutrition comes from the table.
3. For anything else, estimate from typical recipes and portions, then log with `meal --name "Chicken sandwich" --quantity "1 sandwich" --kcal 450 --protein 28 --carbs 40 --fat 18`. Keep estimates realistic for the stated portion.
4. Add `--type breakfast|lunch|dinner|snack`. If they ate earlier than now, add `--at 13:10`, `--at "yesterday 20:30"` or `--at "2026-10-17 20:30"`.
5. Log one entry per item, so each can be corrected on its own.
6. Reply with what you logged: item, amount, calories and protein, then what is left for the day against target. The script prints all of it.

## Logging workouts and weight

- `workout --name "Push day" --duration-min 55 --exercise "Bench press: 4x8 @ 60kg" --exercise "Plank: 3x45s" --exercise "Run: 30 min"`. Write each exercise as `Name: sets x reps @ weight`, `sets x seconds` followed by `s`, or `N min`. Other wording is kept as written.
- `weigh --kg 81.4 [--waist-cm 88] [--body-fat 18]`. When a new weight looks like the new normal (a few weigh-ins agree), update the profile and run `targets set`.

## Reading the log

- `today [--date yesterday]`: targets, totals, what is left and every entry with its ID.
- `week [--end YYYY-MM-DD] [--days 14]`: daily totals, averages on logged days, workouts and the weight change.
- `log [--days 7]`: every entry with its ID, oldest first.

A day with only one or two entries is usually an incomplete log, not a day of eating little. Say so instead of treating it as low intake.

## Corrections

Entries are never deleted. `void m12` takes meal 12 out of every total, and `restore m12` brings it back. IDs start with m for meals, w for workouts and b for weigh-ins. To change an entry, void it and log the corrected one, then tell the person both IDs.
