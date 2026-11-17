# Ganttraah ב-OpenShift 4

## 1. בניית האימג'

במחשב עם גישה לאינטרנט (צריך npm), מתיקיית השורש של הפרויקט:

```
docker build -t gantraah:1.7 .
```

ההעברה לרשת הסגורה, אם צריך:

```
docker save gantraah:1.7 -o gantraah-1.7.tar
```

בצד השני: `docker load -i gantraah-1.7.tar` (או `podman load`).

דחיפה ל-registry של ה-cluster:

```
oc login ...
oc project <project>
REG=$(oc get route default-route -n openshift-image-registry -o jsonpath='{.spec.host}')
docker login -u $(oc whoami) -p $(oc whoami -t) $REG
docker tag gantraah:1.7 $REG/<project>/gantraah:1.7
docker push $REG/<project>/gantraah:1.7
```

- **אימג' הבסיס:** `node:24-alpine`.
- **משתמש:** האימג' רץ כמשתמש לא-root, ומתאים ל-UID האקראי של OpenShift (ה-SCC הרגיל, restricted-v2).

## 2. בוחרים איפה נשמר המידע

בשתי האפשרויות המידע נשמר גם כשהפוד נמחק.

| | `gantraah-postgres.yaml` | `gantraah-pvc.yaml` |
|---|---|---|
| איפה המידע | PostgreSQL חיצוני (15 ומעלה) | מסד מובנה על PVC, בתיקייה `/data` |
| גיבוי | הגיבוי הרגיל של ה-DBA (`pg_dump`) | צריך לגבות את ה-PVC (snapshot או העתקה) |
| מתי לבחור | **מומלץ**, כשיש PostgreSQL של הארגון | כשאין שרת מסד נתונים |

**ב-PostgreSQL 15** משתמש רגיל כבר לא יכול ליצור טבלאות בסכימה `public`. לכן ה-DBA מריץ פעם אחת:

```sql
CREATE DATABASE gantraah;
CREATE USER gantraah WITH PASSWORD '...';
ALTER DATABASE gantraah OWNER TO gantraah;
```

אחרי שהמשתמש הוא הבעלים של המסד, הטבלאות נוצרות ומתעדכנות לבד בכל עלייה. אין שלב נפרד של מיגרציה.

## 3. התקנה

```
oc apply -f gantraah-postgres.yaml     # או gantraah-pvc.yaml
oc get pods -l app=gantraah
oc get route gantraah
```

אחרי שנכנסים: **מחליפים מיד את סיסמת הנהלת הענף**, בהגדרות › מבנה ארגוני והרשאות › "החלף/י סיסמה".

## 4. חשוב לדעת

- **פוד אחד בלבד** (`replicas: 1`): העדכונים החיים בין משתמשים נשמרים בזיכרון של התהליך. ב-PVC זה גם תנאי, כי רק תהליך אחד יכול לפתוח את המסד המובנה.
- **WebSocket:** ה-Route מעביר אותו בנתיב `/ws`. ה-annotation של ה-timeout מונע ניתוק אחרי 30 שניות.
- **עצירה מסודרת:** כשהפוד נעצר (SIGTERM), השרת מסיים את השינוי שבתהליך וסוגר את המסד לפני היציאה.
- **מסד מובנה על PVC:** כמו כל PostgreSQL, הוא נפתח רק תחת המשתמש (UID) שיצר אותו. ב-OpenShift כל הפודים של אותו פרויקט רצים עם אותו UID קבוע, ולכן פוד חדש פותח את המידע בלי בעיה. העברה של ה-PVC לפרויקט **אחר** (UID אחר) דורשת לשנות את בעלות הקבצים, או לעבור ל-PostgreSQL חיצוני.
- **נבדק ב-Docker בתנאים של OpenShift** (משתמש אקראי לא-root, קבוצה 0):
  - **מסד מובנה על volume:** המידע נשאר אחרי מחיקת פוד ואחרי הריגה קשה (kill -9).
  - **PostgreSQL 15:** המידע נשאר גם אחרי החלפת פוד.
- **בדיקת תקינות:** `GET /healthz` מחזיר `{"ok":true,"db":"postgres"}` (או `"embedded"`).
- **לוגים:** יוצאים ל-stdout, ונראים ב-`oc logs`.

**משתני סביבה:**

| משתנה | ברירת מחדל | מה עושה |
|---|---|---|
| `DATABASE_URL` | ריק | כתובת PostgreSQL. ריק = מסד מובנה ב-`DATA_DIR` |
| `DATA_DIR` | `/data/pglite` | איפה נשמר המסד המובנה |
| `DB_SSL` | ריק | הצפנה למסד: `require`, או `verify` (עם `DB_SSL_CA` = נתיב לקובץ ה-CA) |
| `COOKIE_SECURE` | false | `true` כשנכנסים ב-HTTPS |
| `TZ_NAME` | Asia/Jerusalem | לפיו נקבע "היום" במערכת |
| `HISTORY_DAYS` | 365 | כמה ימים נשמרת היסטוריית השינויים |
