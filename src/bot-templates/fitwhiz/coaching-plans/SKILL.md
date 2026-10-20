---
name: coaching-plans
description: Build meal plans and workout plans for the person, and review their progress from the fitness log. Use when they ask for a diet or meal plan, a training programme or routine, a weekly or monthly check-in, or whether what they are doing is working.
---

# Coaching plans

Start from saved data: run `python3 fitwhiz/fitwhiz.py profile` and `targets` (see the fitness-log skill), and read your memory for preferences. Ask only for what is missing and would change the plan, such as meals per day or training days per week. Save new plans as Markdown in `fitwhiz/plans/` so you can find and revise them later, and give the person the file path.

## Meal plans

- Fit the goal, the calorie and macro targets, the diet type, allergies and the number of meals the person eats. Someone non-vegetarian can eat vegetarian food, but never put meat, fish or eggs in a vegetarian plan, or eggs in a plan for someone who doesn't eat them.
- Use familiar foods and realistic portions: whole rotis, bowls, pieces and cups, never "5 g of roti" or "0.25 of an apple" to hit a number. Land within about 10% of the targets and state the difference rather than forcing exact totals.
- Check Indian dishes against the food table with `foods <words>`, and say which values are your estimates.
- Present each meal with its foods and amounts, then its calories, protein, carbs and fat, and finish with the day's totals against the target:

| Meal | Foods and amounts | kcal | Protein | Carbs | Fat |
| --- | --- | --- | --- | --- | --- |

- Offer one or two practical swaps, such as paneer for chicken, or a cheaper or quicker option.

## Workout plans

- Fit the goal, experience, equipment, available days and recovery, and work around injuries. Give a safer alternative for any movement that could aggravate an injury.
- For each session give the exercises with sets, reps or duration, rest between sets, and how hard it should feel (for example, 2 reps left in the tank). Then give the weekly schedule and a simple progression rule, such as adding 2.5 kg once every set reaches the top of the rep range.
- Prefer volume the person can sustain. A beginner does better on 2 or 3 full-body sessions than on a 6-day split.
- Never tell anyone to push through sharp, worsening or unexplained pain. Tell them to stop the exercise and, if it persists, see a physiotherapist or doctor.

## Progress reviews

1. Run `week` (and `week --days 28` for a monthly look) and `today`.
2. Judge trends across days and weeks, not one meal, workout or weigh-in. Daily weight moves by a kilo or more with water and food, so compare averages of several weigh-ins.
3. Separate what was recorded from what you are inferring, and point out days that look incompletely logged.
4. Compare intake, training and weight change with the goal and the planned rate. Losing 0.5 kg a week while aiming for 0.5 is on track; no change over three or more weeks of complete logs means the target needs adjusting.
5. Recommend one or two concrete changes, such as adding a protein source at breakfast, a fourth training day, or 150 kcal less on rest days. If the targets change, update them with `targets set` and say what changed.

Keep a review short: how the week went, what the numbers show, and the one or two changes for next week.
