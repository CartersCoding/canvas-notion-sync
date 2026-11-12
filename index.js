import "dotenv/config";

const CANVAS_DOMAIN = (process.env.CANVAS_DOMAIN || "").trim().replace(/\/+$/, "");
const CANVAS_API_TOKEN = (process.env.CANVAS_API_TOKEN || "").trim();
const NOTION_API_KEY = (process.env.NOTION_API_KEY || "").trim();
const CLASSES_DB_ID = (process.env.CLASSES_DB_ID || "").trim();
const ASSIGNMENTS_DB_ID = (process.env.ASSIGNMENTS_DB_ID || "").trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCanvas(endpoint) {
  const url = CANVAS_DOMAIN + "/api/v1" + endpoint;
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + CANVAS_API_TOKEN },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error("Canvas API error (" + res.status + ") at " + url + ": " + text.slice(0, 200));
  }
  return JSON.parse(text);
}

async function fetchNotion(endpoint, method = "GET", body = null) {
  const url = "https:" + "//" + "api." + "notion." + "com/v1" + endpoint;
  while (true) {
    // Gentle 350ms pacing (~3 req/sec) to stay well under Notion's rate limit
    await sleep(350);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: "Bearer " + NOTION_API_KEY,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      ...(body && { body: JSON.stringify(body) }),
    });

    if (res.status === 429) {
      const waitSec = Number(res.headers.get("retry-after") || 5);
      console.log("⏳ Notion rate limit hit — pausing " + waitSec + "s...");
      await sleep(waitSec * 1000);
      continue;
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error("Notion API error (" + res.status + ") at " + url + ": " + text.slice(0, 300));
    }
    return JSON.parse(text);
  }
}

// Pre-load all existing Notion assignments once so we don't query per item
async function loadExistingAssignments() {
  const map = new Map();
  let cursor = undefined;
  do {
    const res = await fetchNotion("/databases/" + ASSIGNMENTS_DB_ID + "/query", "POST", {
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
    for (const page of res.results) {
      const canvasId = page.properties["Canvas ID"]?.number;
      if (canvasId) map.set(canvasId, page.id);
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return map;
}

async function syncCanvasWithGrades() {
  console.log("Reading classes & existing assignments from Notion...");
  const [classQuery, existingMap] = await Promise.all([
    fetchNotion("/databases/" + CLASSES_DB_ID + "/query", "POST", {
      filter: {
        property: "Canvas Course ID",
        number: { is_not_empty: true },
      },
    }),
    loadExistingAssignments(),
  ]);

  console.log("Found " + existingMap.size + " existing assignments in Notion.");

  if (classQuery.results.length === 0) {
    console.log("No classes found in Notion with a 'Canvas Course ID' filled in.");
    return;
  }

  for (const notionClassPage of classQuery.results) {
    const courseId = notionClassPage.properties["Canvas Course ID"]?.number;
    if (!courseId) continue;

    let course;
    try {
      course = await fetchCanvas("/courses/" + courseId);
    } catch (err) {
      console.log("Could not fetch Canvas course " + courseId + ": " + err.message);
      continue;
    }

    console.log("Syncing: " + course.name + " (ID: " + courseId + ")...");

    try {
      const enrollments = await fetchCanvas(
        "/courses/" + courseId + "/enrollments?user_id=self"
      );
      const currentScore = enrollments.at(0)?.grades?.current_score;
      if (currentScore !== undefined && currentScore !== null) {
        await fetchNotion("/pages/" + notionClassPage.id, "PATCH", {
          properties: {
            "Current Grade": { number: currentScore / 100 },
          },
        });
      }
    } catch {
      // Skips cleanly if Current Grade column isn't present or score isn't available
    }

    const assignments = await fetchCanvas(
      "/courses/" + courseId + "/assignments?include[]=submission&per_page=100"
    );

    for (const item of assignments) {
      const submission = item.submission;
      const isSubmitted =
        submission?.workflow_state === "submitted" ||
        submission?.workflow_state === "graded";

      const properties = {
        Name: { title: [{ text: { content: item.name } }] },
        Course: { relation: [{ id: notionClassPage.id }] },
        "Canvas ID": { number: item.id },
        Points: { number: item.points_possible || 0 },
        URL: { url: item.html_url },
        Type: {
          select: {
            name: item.is_quiz_assignment
              ? "Quiz"
              : item.discussion_topic
              ? "Discussion"
              : "Assignment",
          },
        },
        Status: {
          status: { name: isSubmitted ? "Done" : "Not started" },
        },
        ...(item.due_at && {
          "Due Date": { date: { start: item.due_at } },
        }),
        ...(submission?.score !== null &&
          submission?.score !== undefined && {
            Score: { number: submission.score },
          }),
      };

      const existingPageId = existingMap.get(item.id);
      if (existingPageId) {
        await fetchNotion("/pages/" + existingPageId, "PATCH", { properties });
      } else {
        const created = await fetchNotion("/pages", "POST", {
          parent: { database_id: ASSIGNMENTS_DB_ID },
          properties,
        });
        existingMap.set(item.id, created.id);
      }
    }
    console.log("✅ Synced " + assignments.length + " assignments for: " + course.name);
  }
  console.log("🎉 Sync complete!");
}

syncCanvasWithGrades().catch(console.error);
