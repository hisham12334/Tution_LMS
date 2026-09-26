# Northstar Learning LMS — approval prototype

The proposed system architecture, roles, data model, flows, and build order are in [ARCHITECTURE.md](ARCHITECTURE.md). The current files are a visual prototype; application implementation begins after the architecture is agreed.

Open `index.html` in a browser to review the front-end concept.

## What this prototype demonstrates

- **Student dashboard:** next lesson, weekly learning plan, progress, upcoming live classes, and assignment deadlines.
- **Teacher / admin dashboard:** student overview, marking queue, course health, and class schedule.
- **Role preview:** use the Student / Teacher / Admin switch at the top to move between the two experiences.

## Suggested delivery plan

1. **Approval and visual direction** — confirm branding, course categories, and the exact student navigation.
2. **Foundation** — authentication, roles, student profiles, cohorts, and a secure admin workspace.
3. **Teaching operations** — lesson/content management, class timetable, recordings, assignments, submissions, marking, and feedback.
4. **Student experience** — real lesson player, progress tracking, notifications, calendar, and downloadable resources.
5. **Finish and launch** — analytics, reports, QA, mobile tuning, data migration, and staff training.

## Data model to connect next

`users` → `roles` → `cohorts` → `courses` → `lessons` → `enrolments` → `progress` → `assignments` → `submissions` → `feedback`

The current controls are intentionally prototype interactions; they clearly identify where the live flows will attach once the stack is selected.
