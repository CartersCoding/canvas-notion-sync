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

// Pre-load existing Notion assignments + their current values for smart diffing
async function loadExistingAssignments() {
  const map = new Map();
  let cursor = undefined;
  do {
    const res = await fetchNotion("/databases/" + ASSIGNMENTS_DB_ID + "/query", "POST", {
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
    for (const page of res.results) {
      const p = page.properties;
      const canvasId = p["Canvas ID"]?.number;
      if (canvasId) {
        map.set(canvasId, {
          id: page.id,
          name: p.Name?.title?.at(0)?.plain_text || "",
          dueDate: p["Due Date"]?.date?.start || null,
          points: p.Points?.number ?? 0,
          score: p.Score?.number ?? null,
          status: p.Status?.status?.name || "Not started",
          courseId: p.Course?.relation?.at(0)?.id || null,
        });
      }
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
      const existingGrade = notionClassPage.properties["Current Grade"]?.number;
      if (currentScore !== undefined && currentScore !== null) {
        const normalized = Math.round(currentScore * 100) / 10000;
        if (existingGrade !== normalized) {
          await fetchNotion("/pages/" + notionClassPage.id, "PATCH", {
            properties: {
              "Current Grade": { number: normalized },
            },
          });
        }
      }
    } catch {
      // Skips cleanly if Current Grade column isn't present or score isn't available
    }

    const assignments = await fetchCanvas(
      "/courses/" + courseId + "/assignments?include[]=submission&per_page=100"
    );

    let updatedCount = 0;

    for (const item of assignments) {
      const submission = item.submission;
      const isSubmittedOnCanvas =
        submission?.workflow_state === "submitted" ||
        submission?.workflow_state === "graded";

      const newPoints = item.points_possible || 0;
      const newScore =
        submission?.score !== null && submission?.score !== undefined
          ? submission.score
          : null;
      const newDueDate = item.due_at || null;

      const existing = existingMap.get(item.id);

      // Protect manual Notion status: only auto-promote to "Done" if Canvas shows submitted/graded
      let targetStatus = existing ? existing.status : "Not started";
      if (isSubmittedOnCanvas) {
        targetStatus = "Done";
      }

      const properties = {
        Name: { title: [{ text: { content: item.name } }] },
        Course: { relation: [{ id: notionClassPage.id }] },
        "Canvas ID": { number: item.id },
        Points: { number: newPoints },
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
          status: { name: targetStatus },
        },
        ...(newDueDate && {
          "Due Date": { date: { start: newDueDate } },
        }),
        ...(newScore !== null && {
          Score: { number: newScore },
        }),
      };

      if (existing) {
        // Smart diff: skip API update if nothing actually changed!
        const sameDue =
          (existing.dueDate || "").slice(0, 16) === (newDueDate || "").slice(0, 16);
        const isUnchanged =
          existing.name === item.name &&
          existing.courseId === notionClassPage.id &&
          existing.points === newPoints &&
          existing.score === newScore &&
          existing.status === targetStatus &&
          sameDue;

        if (isUnchanged) continue;

        await fetchNotion("/pages/" + existing.id, "PATCH", { properties });
        updatedCount++;
      } else {
        const created = await fetchNotion("/pages", "POST", {
          parent: { database_id: ASSIGNMENTS_DB_ID },
          properties,
        });
        existingMap.set(item.id, {
          id: created.id,
          name: item.name,
          dueDate: newDueDate,
          points: newPoints,
          score: newScore,
          status: targetStatus,
          courseId: notionClassPage.id,
        });
        updatedCount++;
      }
    }
    console.log(
      "✅ " + course.name + ": " + updatedCount + " created/updated (" + (assignments.length - updatedCount) + " unchanged)"
    );
  }
  console.log("🎉 Sync complete!");
}

syncCanvasWithGrades().catch(console.error);
