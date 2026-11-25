const ACTIVE_WINDOW_MS = 30000;
const supabaseClient = window.examwatchSupabase;

const adminApp = document.getElementById("adminApp");
const pageTitle = document.getElementById("pageTitle");
const dataStatus = document.getElementById("dataStatus");
const assessmentDialog = document.getElementById("assessmentDialog");
const assessmentForm = document.getElementById("assessmentForm");
const questionEditorList = document.getElementById("questionEditorList");
const imageQuestionEditorList = document.getElementById("imageQuestionEditorList");
const assessmentFormError = document.getElementById("assessmentFormError");
const assessmentFilesBucket = "examwatch-assessment-files";
const assessmentPreviewDialog = document.getElementById("assessmentPreviewDialog");
const assessmentPreviewQuestions = document.getElementById("assessmentPreviewQuestions");
let loadedResults = [];

function showPage(name) {
  const target = document.getElementById(`page-${name}`);
  if (!target) return;
  document.querySelectorAll(".page-section").forEach(section => {
    section.classList.toggle("hidden", section !== target);
  });
  document.querySelectorAll(".nav-link").forEach(link => {
    const active = link.dataset.page === name;
    link.classList.toggle("active", active);
    link.setAttribute("aria-current", active ? "page" : "false");
  });
  pageTitle.textContent = name === "activity" ? "Activity logs" : name === "monitoring" ? "Live monitoring" : name.charAt(0).toUpperCase() + name.slice(1);
  refreshDashboard();
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function initials(value) {
  return String(value || "?").trim().charAt(0).toUpperCase() || "?";
}

function appendCell(row, content, className) {
  const cell = document.createElement("td");
  if (content instanceof Node) cell.appendChild(content);
  else cell.textContent = String(content ?? "—");
  if (className) cell.className = className;
  row.appendChild(cell);
  return cell;
}

function makeStudentCell(username, email) {
  const wrapper = document.createElement("div");
  wrapper.className = "student-cell";
  const dot = document.createElement("span");
  dot.className = "student-dot";
  dot.textContent = initials(username || email);
  const label = document.createElement("span");
  label.className = "student-label";
  const name = document.createElement("strong");
  name.textContent = username || "Unknown student";
  const address = document.createElement("small");
  address.textContent = email || "Email unavailable";
  label.append(name, address);
  wrapper.append(dot, label);
  return wrapper;
}

function makeEmptyRow(tbody, columnCount, message, detail) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = columnCount;
  cell.className = "empty-state";
  const title = document.createElement("strong");
  title.textContent = message;
  cell.append(title, document.createTextNode(detail));
  row.appendChild(cell);
  tbody.appendChild(row);
}

function scoreChip(score, total) {
  const chip = document.createElement("span");
  chip.className = `score-chip${score === null ? " score-pending" : ""}`;
  chip.textContent = score === null ? "Needs review" : `${score ?? 0} / ${total ?? 0}`;
  return chip;
}

function imageExtension(file) {
  return ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" })[file.type] || "";
}

async function setSignedImage(image, path) {
  const { data, error } = await supabaseClient.storage.from(assessmentFilesBucket).createSignedUrl(path, 21600);
  if (error) throw error;
  if (image.dataset.objectUrl) return;
  image.src = data.signedUrl;
  image.hidden = false;
}

function setAssessmentEditorMode() {
  const imageMode = document.getElementById("assessmentTypeInput").value === "image_based";
  document.getElementById("multipleChoiceEditor").classList.toggle("hidden", imageMode);
  document.getElementById("imageAssessmentEditor").classList.toggle("hidden", !imageMode);
  document.getElementById("multipleChoiceEditor").querySelectorAll("input").forEach(input => {
    input.disabled = imageMode;
  });
  document.getElementById("imageAssessmentEditor").querySelectorAll("input, textarea, select").forEach(input => {
    input.disabled = !imageMode;
  });
}

function statusChip(status, stale = false) {
  const chip = document.createElement("span");
  chip.className = `status-chip ${status === "hidden" || status === "paused" ? "status-hidden" : "status-active"}`;
  chip.textContent = stale ? "Disconnected" : status === "hidden" ? "Window/page away" : status === "paused" ? "Paused" : "Taking assessment";
  return chip;
}

function renderRecentResults(results) {
  const tbody = document.getElementById("recentResultsBody");
  tbody.replaceChildren();
  if (!results.length) {
    makeEmptyRow(tbody, 4, "No submissions yet", "Student results will appear after an assessment is submitted.");
    return;
  }
  results.slice(0, 5).forEach(result => {
    const row = document.createElement("tr");
    appendCell(row, makeStudentCell(result.studentUsername, result.student));
    appendCell(row, result.assessmentTitle || result.subject);
    appendCell(row, scoreChip(result.score, result.total));
    appendCell(row, formatTime(result.submittedAt));
    tbody.appendChild(row);
  });
}

function renderLiveLists(sessions) {
  const tbody = document.getElementById("monitoringBody");
  const dashboardList = document.getElementById("dashboardLiveList");
  tbody.replaceChildren();
  dashboardList.replaceChildren();
  document.getElementById("liveBadge").textContent = String(sessions.length);
  document.getElementById("liveBadge").classList.toggle("hidden", sessions.length === 0);

  if (!sessions.length) {
    makeEmptyRow(tbody, 5, "No active sessions", "A student appears here after starting an assessment.");
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("strong");
    title.textContent = "No students online";
    empty.append(title, document.createTextNode("Live sessions will show here."));
    dashboardList.appendChild(empty);
    return;
  }

  sessions.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
  sessions.forEach(session => {
    const row = document.createElement("tr");
    appendCell(row, makeStudentCell(session.studentUsername, session.student));
    appendCell(row, session.assessmentTitle || session.subject);
    appendCell(row, statusChip(session.status));
    appendCell(row, session.violations || 0);
    appendCell(row, formatDate(session.lastSeen));
    tbody.appendChild(row);
  });

  sessions.slice(0, 4).forEach(session => {
    const item = document.createElement("div");
    item.className = "activity-item";
    const mark = document.createElement("span");
    mark.className = "activity-mark";
    mark.textContent = session.status === "hidden" ? "!" : initials(session.student);
    const copy = document.createElement("div");
    copy.className = "activity-copy";
    const title = document.createElement("strong");
    title.textContent = session.student || "Unknown student";
    const detail = document.createElement("span");
    detail.textContent = `${session.assessmentTitle || session.subject} · ${session.status === "hidden" ? "Window/page away" : "Taking assessment"}`;
    copy.append(title, detail);
    item.append(mark, copy);
    dashboardList.appendChild(item);
  });
}

function renderAssessments(assessments) {
  const tbody = document.getElementById("assessmentsBody");
  tbody.replaceChildren();
  if (!assessments.length) {
    makeEmptyRow(tbody, 6, "No assessments yet", "Create an assessment to publish it to students.");
    return;
  }
  assessments.forEach(assessment => {
    const row = document.createElement("tr");
    appendCell(row, assessment.title);
    appendCell(row, assessment.subject);
    appendCell(row, assessment.questions.length);
    appendCell(row, `${assessment.duration_minutes} minutes`);
    const status = document.createElement("span");
    status.className = `status-chip ${assessment.is_open ? "status-active" : "status-hidden"}`;
    status.textContent = assessment.is_open ? "Open" : "Closed";
    appendCell(row, status);
    const actions = document.createElement("div");
    actions.className = "assessment-actions";
    const edit = document.createElement("button");
    edit.className = "table-action";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => editAssessment(assessment));
    const preview = document.createElement("button");
    preview.className = "table-action";
    preview.type = "button";
    preview.textContent = "Preview";
    preview.addEventListener("click", () => previewAssessment(assessment, preview));
    actions.append(edit, preview);
    const toggle = document.createElement("button");
    toggle.className = `table-action ${assessment.is_open ? "action-close" : "action-open"}`;
    toggle.type = "button";
    toggle.textContent = assessment.is_open ? "Close" : "Open";
    toggle.addEventListener("click", () => toggleAssessment(assessment));
    const remove = document.createElement("button");
    remove.className = "table-action action-delete";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteAssessment(assessment, remove));
    actions.append(toggle, remove);
    appendCell(row, actions);
    tbody.appendChild(row);
  });
}

async function previewAssessment(assessment, button) {
  button.disabled = true;
  document.getElementById("assessmentPreviewTitle").textContent = assessment.title;
  document.getElementById("assessmentPreviewMeta").textContent =
    `${assessment.subject} · ${assessment.duration_minutes} minutes · ${assessment.questions.length} questions · ` +
    `${assessment.assessment_type === "image_based" ? "Image worksheet" : "Multiple choice"}`;
  assessmentPreviewQuestions.replaceChildren();

  const imageLoads = [];
  assessment.questions.forEach((question, index) => {
    const card = document.createElement("article");
    card.className = "assessment-preview-question";
    const heading = document.createElement("h3");
    heading.textContent = `Question ${index + 1}`;
    card.appendChild(heading);

    if (question.q) {
      const prompt = document.createElement("p");
      prompt.className = "assessment-preview-prompt";
      prompt.textContent = question.q;
      card.appendChild(prompt);
    }

    if (assessment.assessment_type === "image_based") {
      if (question.image_path) {
        const image = document.createElement("img");
        image.className = "assessment-preview-image";
        image.alt = `Assessment image for question ${index + 1}`;
        image.hidden = true;
        const imageStatus = document.createElement("p");
        imageStatus.className = "assessment-preview-image-status";
        imageStatus.textContent = "Loading image…";
        card.append(image, imageStatus);
        imageLoads.push(
          setSignedImage(image, question.image_path)
            .then(() => imageStatus.remove())
            .catch(error => {
              console.error("[ExamWatch Admin] Could not load assessment preview image.", error);
              imageStatus.textContent = "Could not load this assessment image.";
            })
        );
      } else {
        const missingImage = document.createElement("p");
        missingImage.className = "assessment-preview-image-status";
        missingImage.textContent = "No image is saved for this question.";
        card.appendChild(missingImage);
      }
    } else {
      const choices = document.createElement("ol");
      choices.className = "assessment-preview-choices";
      (Array.isArray(question.o) ? question.o : []).forEach((choice, choiceIndex) => {
        const item = document.createElement("li");
        const letter = document.createElement("strong");
        letter.textContent = `${String.fromCharCode(65 + choiceIndex)}.`;
        const text = document.createElement("span");
        text.textContent = choice;
        item.append(letter, text);
        choices.appendChild(item);
      });
      card.appendChild(choices);
    }
    assessmentPreviewQuestions.appendChild(card);
  });

  assessmentPreviewDialog.showModal();
  await Promise.all(imageLoads);
  button.disabled = false;
}

function addQuestionEditor(question = { q: "", o: ["", "", "", ""] }, answer = 0) {
  const index = questionEditorList.children.length;
  const card = document.createElement("section");
  card.className = "question-card-editor";
  const head = document.createElement("div");
  head.className = "question-card-editor-head";
  const number = document.createElement("span");
  number.textContent = `Question ${index + 1}`;
  const remove = document.createElement("button");
  remove.className = "remove-question";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    card.remove();
    renumberQuestionEditors();
  });
  head.append(number, remove);

  const questionInput = document.createElement("input");
  questionInput.type = "text";
  questionInput.maxLength = 1000;
  questionInput.required = true;
  questionInput.dataset.question = "text";
  questionInput.placeholder = "Type the question";
  questionInput.value = question.q || "";
  const choices = document.createElement("div");
  choices.className = "choice-editor";
  ["A", "B", "C", "D"].forEach((letter, choiceIndex) => {
    const label = document.createElement("label");
    label.className = "choice-field";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `correct-answer-${index}`;
    radio.value = String(choiceIndex);
    radio.required = choiceIndex === 0;
    radio.checked = answer === choiceIndex;
    radio.setAttribute("aria-label", `Choice ${letter} is correct`);
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 500;
    input.required = true;
    input.dataset.choice = String(choiceIndex);
    input.placeholder = `Choice ${letter}`;
    input.value = question.o?.[choiceIndex] || "";
    label.append(radio, input);
    choices.appendChild(label);
  });
  card.append(head, questionInput, choices);
  questionEditorList.appendChild(card);
}

function addImageQuestionEditor(question = {}, answer = "") {
  const index = imageQuestionEditorList.children.length;
  const card = document.createElement("section");
  card.className = "question-card-editor image-question-editor";
  card.dataset.imagePath = question.image_path || "";

  const head = document.createElement("div");
  head.className = "question-card-editor-head";
  const number = document.createElement("span");
  number.textContent = `Image ${index + 1}`;
  const remove = document.createElement("button");
  remove.className = "remove-question";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    card.remove();
    renumberImageQuestionEditors();
  });
  head.append(number, remove);

  const prompt = document.createElement("input");
  prompt.type = "text";
  prompt.maxLength = 1000;
  prompt.dataset.imagePrompt = "text";
  prompt.placeholder = "Optional instruction or question";
  prompt.value = question.q || "";

  const preview = document.createElement("img");
  preview.className = "image-question-preview";
  preview.alt = `Uploaded assessment image ${index + 1}`;
  preview.hidden = true;
  if (question.image_path) {
    setSignedImage(preview, question.image_path).catch(error => {
      console.error("[ExamWatch Admin] Could not load assessment image preview.", error);
    });
  }

  const fileLabel = document.createElement("label");
  fileLabel.className = "image-file-label";
  fileLabel.appendChild(document.createTextNode("Question image (JPG, PNG, or WebP; up to 10 MB)"));
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "image/jpeg,image/png,image/webp";
  file.dataset.imageFile = "file";
  const fileStatus = document.createElement("small");
  fileStatus.textContent = question.image_path ? "Current image kept unless replaced." : "";
  file.addEventListener("change", () => {
    const selected = file.files[0];
    if (!selected) return;
    if (!imageExtension(selected) || selected.size > 10 * 1024 * 1024) {
      card.dataset.invalidImage = "true";
      file.value = "";
      fileStatus.textContent = "Pumili ng JPG, PNG, o WebP na hanggang 10 MB.";
      return;
    }
    delete card.dataset.invalidImage;
    fileStatus.textContent = selected.name;
    if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    preview.dataset.objectUrl = URL.createObjectURL(selected);
    preview.src = preview.dataset.objectUrl;
    preview.hidden = false;
  });
  fileLabel.append(file, fileStatus);

  const answerLabel = document.createElement("label");
  answerLabel.className = "expected-answer-label";
  answerLabel.appendChild(document.createTextNode("Expected typed answer (case/space-insensitive automatic grading)"));
  const expectedAnswer = document.createElement("textarea");
  expectedAnswer.maxLength = 10000;
  expectedAnswer.required = true;
  expectedAnswer.dataset.expectedAnswer = "text";
  expectedAnswer.placeholder = "Enter the answer students should type";
  expectedAnswer.value = answer || "";
  answerLabel.appendChild(expectedAnswer);

  card.append(head, prompt, preview, fileLabel, answerLabel);
  imageQuestionEditorList.appendChild(card);
}

function renumberImageQuestionEditors() {
  [...imageQuestionEditorList.children].forEach((card, index) => {
    card.querySelector(".question-card-editor-head span").textContent =
      document.getElementById("imageLayoutInput").value === "worksheet"
        ? `Worksheet question ${index + 1}`
        : `Image ${index + 1}`;
  });
}

function updateImageLayout() {
  const wholeWorksheet = document.getElementById("imageLayoutInput").value === "worksheet";
  const cards = [...imageQuestionEditorList.children];
  const sharedImagePath = cards[0]?.dataset.imagePath || "";
  cards.forEach((card, index) => {
    const fileLabel = card.querySelector(".image-file-label");
    const preview = card.querySelector(".image-question-preview");
    if (wholeWorksheet) {
      card.dataset.imagePath = sharedImagePath;
      fileLabel.firstChild.textContent = "Whole worksheet image (JPG, PNG, or WebP; up to 10 MB)";
      fileLabel.classList.toggle("hidden", index > 0);
      if (index > 0) preview.hidden = true;
    } else {
      fileLabel.firstChild.textContent = "Question image (JPG, PNG, or WebP; up to 10 MB)";
      fileLabel.classList.remove("hidden");
      if (preview.dataset.objectUrl) {
        preview.hidden = false;
      } else if (card.dataset.imagePath) {
        preview.hidden = true;
        setSignedImage(preview, card.dataset.imagePath).catch(error => {
          console.error("[ExamWatch Admin] Could not load assessment image preview.", error);
        });
      }
    }
  });
  document.getElementById("imageQuestionHeading").textContent = wholeWorksheet ? "Worksheet answer items" : "Image questions";
  document.getElementById("imageQuestionHelp").textContent = wholeWorksheet
    ? "Add an expected typed answer for each worksheet question."
    : "Add an expected typed answer for each image.";
  document.getElementById("addImageQuestionButton").textContent = wholeWorksheet ? "+ Add question" : "+ Add image";
  renumberImageQuestionEditors();
}

function clearImageQuestionEditors() {
  [...imageQuestionEditorList.children].forEach(card => {
    const preview = card.querySelector(".image-question-preview");
    if (preview?.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
  });
  imageQuestionEditorList.replaceChildren();
}

function renumberQuestionEditors() {
  [...questionEditorList.children].forEach((card, index) => {
    card.querySelector(".question-card-editor-head span").textContent = `Question ${index + 1}`;
    card.querySelectorAll('input[type="radio"]').forEach(radio => {
      radio.name = `correct-answer-${index}`;
      radio.required = radio.value === "0";
    });
  });
}

function resetAssessmentForm() {
  assessmentForm.reset();
  document.getElementById("assessmentId").value = "";
  document.getElementById("assessmentDialogTitle").textContent = "New assessment";
  document.getElementById("assessmentOpenInput").checked = true;
  document.getElementById("assessmentDurationInput").value = "45";
  document.getElementById("assessmentTypeInput").value = "multiple_choice";
  document.getElementById("imageLayoutInput").value = "per_question";
  document.getElementById("shuffleQuestionsInput").checked = false;
  questionEditorList.replaceChildren();
  clearImageQuestionEditors();
  addQuestionEditor();
  addImageQuestionEditor();
  updateImageLayout();
  setAssessmentEditorMode();
  assessmentFormError.textContent = "";
  assessmentFormError.classList.add("hidden");
}

async function editAssessment(assessment) {
  const { data: keyRecord, error } = await supabaseClient
    .from("assessment_answer_keys")
    .select("answers")
    .eq("assessment_id", assessment.id)
    .single();
  if (error) {
    console.error("[ExamWatch Admin] Could not load assessment answer key.", error);
    window.alert("Hindi mabuksan ang assessment. Tingnan kung na-run ang assessment-management SQL.");
    return;
  }

  resetAssessmentForm();
  document.getElementById("assessmentDialogTitle").textContent = "Edit assessment";
  document.getElementById("assessmentId").value = assessment.id;
  document.getElementById("assessmentTitleInput").value = assessment.title;
  document.getElementById("assessmentSubjectInput").value = assessment.subject;
  document.getElementById("assessmentDurationInput").value = String(assessment.duration_minutes);
  document.getElementById("assessmentOpenInput").checked = assessment.is_open;
  document.getElementById("assessmentTypeInput").value = assessment.assessment_type || "multiple_choice";
  document.getElementById("imageLayoutInput").value = assessment.image_layout || "per_question";
  document.getElementById("shuffleQuestionsInput").checked = Boolean(assessment.shuffle_questions);
  questionEditorList.replaceChildren();
  clearImageQuestionEditors();
  if (assessment.assessment_type === "image_based") {
    assessment.questions.forEach((question, index) => addImageQuestionEditor(question, keyRecord.answers[index]));
  } else {
    assessment.questions.forEach((question, index) => addQuestionEditor(question, keyRecord.answers[index]));
  }
  updateImageLayout();
  setAssessmentEditorMode();
  assessmentDialog.showModal();
}

async function toggleAssessment(assessment) {
  const action = assessment.is_open ? "close" : "open";
  if (!window.confirm(`${assessment.is_open ? "Close" : "Open"} "${assessment.title}" for new students?`)) return;
  const { data: keyRecord, error: keyError } = await supabaseClient
    .from("assessment_answer_keys")
    .select("answers")
    .eq("assessment_id", assessment.id)
    .single();
  if (keyError) {
    console.error("[ExamWatch Admin] Could not load assessment answer key.", keyError);
    window.alert("Hindi mabago ang assessment status. Tingnan kung na-run ang assessment-management SQL.");
    return;
  }
  const { error } = await supabaseClient.rpc("save_examwatch_assessment", {
    p_assessment_id: assessment.id,
    p_title: assessment.title,
    p_subject: assessment.subject,
    p_duration_minutes: assessment.duration_minutes,
    p_questions: assessment.questions,
    p_answers: keyRecord.answers,
    p_is_open: !assessment.is_open,
    p_assessment_type: assessment.assessment_type || "multiple_choice",
    p_image_layout: assessment.image_layout || "per_question",
    p_shuffle_questions: Boolean(assessment.shuffle_questions)
  });
  if (error) {
    console.error(`[ExamWatch Admin] Could not ${action} assessment.`, error);
    window.alert(`Hindi ma-${action} ang assessment. Tingnan ang koneksyon at database setup.`);
    return;
  }
  await refreshDashboard();
}

async function deleteAssessment(assessment, button) {
  const confirmed = window.confirm(
    `Permanently delete "${assessment.title}"? Student results will be kept, but active students will no longer be able to continue this assessment. This cannot be undone.`
  );
  if (!confirmed) return;

  button.disabled = true;
  const { data: deletedAssessment, error } = await supabaseClient
    .from("assessments")
    .delete()
    .eq("id", assessment.id)
    .select("id")
    .single();
  if (error || !deletedAssessment) {
    console.error("[ExamWatch Admin] Could not delete assessment.", error || new Error("Assessment was not deleted."));
    window.alert("Hindi na-delete ang assessment. Tingnan ang koneksyon at database setup, saka subukan ulit.");
    button.disabled = false;
    return;
  }

  const imagePaths = [...new Set(
    assessment.questions
      .map(question => question.image_path)
      .filter(path => typeof path === "string" && path.startsWith(`questions/${assessment.id}/`))
  )];
  let imageCleanupError = null;
  if (imagePaths.length) {
    const { error: cleanupError } = await supabaseClient.storage
      .from(assessmentFilesBucket)
      .remove(imagePaths);
    imageCleanupError = cleanupError;
    if (cleanupError) {
      console.error("[ExamWatch Admin] Assessment was deleted, but its images could not be removed.", cleanupError);
    }
  }

  await refreshDashboard();
  if (imageCleanupError) {
    window.alert("Na-delete ang assessment, pero hindi naalis ang ilan sa mga larawan nito. Tingnan ang console at storage permissions.");
  }
}

async function saveAssessment(event) {
  event.preventDefault();
  assessmentFormError.classList.add("hidden");
  const imageMode = document.getElementById("assessmentTypeInput").value === "image_based";
  const imageLayout = document.getElementById("imageLayoutInput").value;
  const cards = [...(imageMode ? imageQuestionEditorList : questionEditorList).querySelectorAll(".question-card-editor")];
  if (!cards.length) {
    assessmentFormError.textContent = "Magdagdag ng kahit isang tanong.";
    assessmentFormError.classList.remove("hidden");
    return;
  }

  const questions = [];
  const answers = [];
  const imageFiles = [];
  const worksheetImagePath = imageMode && imageLayout === "worksheet" ? cards[0].dataset.imagePath : "";
  const worksheetImageFile = imageMode && imageLayout === "worksheet"
    ? cards[0].querySelector("[data-image-file]").files[0] || null
    : null;
  const worksheetHasImage = Boolean(worksheetImagePath || worksheetImageFile);
  for (const [index, card] of cards.entries()) {
    if (imageMode) {
      const selectedFile = card.querySelector("[data-image-file]").files[0] || null;
      const file = imageLayout === "worksheet" ? index === 0 ? selectedFile : null : selectedFile;
      const imagePath = imageLayout === "worksheet" ? worksheetImagePath : card.dataset.imagePath;
      const questionText = card.querySelector("[data-image-prompt]").value.trim();
      const expectedAnswer = card.querySelector("[data-expected-answer]").value.trim();
      if ((imageLayout !== "worksheet" || index === 0) && card.dataset.invalidImage === "true"
        || (!file && !imagePath && !(imageLayout === "worksheet" && worksheetHasImage))
        || (file && (!imageExtension(file) || file.size > 10 * 1024 * 1024))) {
        assessmentFormError.textContent = `Mag-upload ng valid na JPG, PNG, o WebP na larawan (hanggang 10 MB) para sa image ${index + 1}.`;
        assessmentFormError.classList.remove("hidden");
        return;
      }
      if (!expectedAnswer) {
        assessmentFormError.textContent = `Ilagay ang expected typed answer para sa image ${index + 1}.`;
        assessmentFormError.classList.remove("hidden");
        return;
      }
      questions.push({
        q: questionText || `Question ${index + 1}`,
        image_path: imagePath
      });
      answers.push(expectedAnswer);
      if (file) imageFiles.push({ file, index });
    } else {
      const questionText = card.querySelector("[data-question]").value.trim();
      const choices = [...card.querySelectorAll("[data-choice]")].map(input => input.value.trim());
      const correctChoice = card.querySelector('input[type="radio"]:checked');
      if (!questionText || choices.some(choice => !choice) || !correctChoice) {
        assessmentFormError.textContent = `Kumpletuhin ang tanong ${index + 1}, apat na choices, at tamang sagot.`;
        assessmentFormError.classList.remove("hidden");
        return;
      }
      questions.push({ q: questionText, o: choices });
      answers.push(Number(correctChoice.value));
    }
  }

  const saveButton = document.getElementById("saveAssessmentButton");
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  const currentId = document.getElementById("assessmentId").value;
  const assessmentId = currentId || (imageMode ? crypto.randomUUID() : null);
  const uploadedPaths = [];
  let assessmentSaved = false;
  try {
    for (const { file, index } of imageFiles) {
      const path = `questions/${assessmentId}/${index}/${crypto.randomUUID()}.${imageExtension(file)}`;
      const { error: uploadError } = await supabaseClient.storage
        .from(assessmentFilesBucket)
        .upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) throw uploadError;
      uploadedPaths.push(path);
      questions[index].image_path = path;
    }
    if (imageMode && imageLayout === "worksheet" && questions.length > 1) {
      questions.forEach(question => { question.image_path = questions[0].image_path; });
    }

    const { error } = await supabaseClient.rpc("save_examwatch_assessment", {
      p_assessment_id: assessmentId,
      p_title: document.getElementById("assessmentTitleInput").value.trim(),
      p_subject: document.getElementById("assessmentSubjectInput").value.trim(),
      p_duration_minutes: Number(document.getElementById("assessmentDurationInput").value),
      p_questions: questions,
      p_answers: answers,
      p_is_open: document.getElementById("assessmentOpenInput").checked,
      p_assessment_type: imageMode ? "image_based" : "multiple_choice",
      p_image_layout: imageMode ? imageLayout : "per_question",
      p_shuffle_questions: document.getElementById("shuffleQuestionsInput").checked
    });
    if (error) throw error;
    assessmentSaved = true;
    assessmentDialog.close();
    await refreshDashboard();
  } catch (error) {
    console.error("[ExamWatch Admin] Could not save assessment.", error);
    if (!assessmentSaved && uploadedPaths.length) {
      const { error: cleanupError } = await supabaseClient.storage.from(assessmentFilesBucket).remove(uploadedPaths);
      if (cleanupError) console.error("[ExamWatch Admin] Could not clean up uploaded assessment images.", cleanupError);
    }
    assessmentFormError.textContent = `Hindi na-save ang assessment. ${error?.message || "Suriin ang fields at database setup, saka subukan ulit."}`;
    assessmentFormError.classList.remove("hidden");
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save assessment";
  }
}

function renderActivity(activities) {
  const container = document.getElementById("activityBody");
  const openStudentGroups = new Set(
    [...container.querySelectorAll(".activity-student-group[open]")]
      .map(group => group.dataset.studentKey)
      .filter(Boolean)
  );
  container.replaceChildren();
  if (!activities.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("strong");
    title.textContent = "No activity recorded";
    const detail = document.createElement("span");
    detail.textContent = "Start, page visibility, and submission events will appear here.";
    empty.append(title, detail);
    container.appendChild(empty);
    return;
  }

  const students = new Map();
  activities.forEach(activity => {
    const identity = (activity.student || activity.studentUsername || "Unknown student").trim().toLowerCase();
    if (!students.has(identity)) {
      students.set(identity, {
        username: activity.studentUsername,
        email: activity.student,
        activities: []
      });
    }
    students.get(identity).activities.push(activity);
  });

  students.forEach(student => {
    const group = document.createElement("details");
    group.className = "activity-student-group";
    const identityKey = (student.email || student.username || "Unknown student").trim().toLowerCase();
    group.dataset.studentKey = identityKey;
    group.open = openStudentGroups.has(identityKey);
    const summary = document.createElement("summary");
    const identity = makeStudentCell(student.username, student.email);
    const count = document.createElement("span");
    count.className = "activity-event-count";
    count.textContent = `${student.activities.length} ${student.activities.length === 1 ? "event" : "events"}`;
    summary.append(identity, count);
    group.appendChild(summary);

    const events = document.createElement("ol");
    events.className = "activity-event-list";
    student.activities.forEach(activity => {
      const event = document.createElement("li");
      event.className = "activity-event";
      const eventHeading = document.createElement("div");
      eventHeading.className = "activity-event-heading";
      const label = document.createElement("strong");
      label.textContent = activity.label || activity.type || "Activity";
      const time = document.createElement("time");
      time.dateTime = activity.at || "";
      time.textContent = formatDate(activity.at);
      eventHeading.append(label, time);

      const assessment = document.createElement("p");
      assessment.className = "activity-event-assessment";
      assessment.textContent = activity.assessmentTitle || activity.subject || "Assessment";
      event.append(eventHeading, assessment);
      if (activity.detail) {
        const detail = document.createElement("p");
        detail.className = "activity-event-detail";
        detail.textContent = activity.detail;
        event.appendChild(detail);
      }
      events.appendChild(event);
    });
    group.appendChild(events);
    container.appendChild(group);
  });
}

function renderResults(results) {
  const tbody = document.getElementById("resultsBody");
  const query = document.getElementById("resultSearch").value.trim();
  const filtered = getFilteredResults(results, query);
  tbody.replaceChildren();
  document.getElementById("exportResultsButton").disabled = filtered.length === 0;
  document.getElementById("resultsCount").textContent = `${filtered.length} result${filtered.length === 1 ? "" : "s"}`;
  if (!filtered.length) {
    makeEmptyRow(tbody, 5, query ? "No matching results" : "No results yet", query ? "Try a different search." : "Submitted assessments will appear here.");
    return;
  }
  filtered.forEach(result => {
    const row = document.createElement("tr");
    appendCell(row, makeStudentCell(result.studentUsername, result.student));
    appendCell(row, result.assessmentTitle || result.subject);
    appendCell(row, scoreChip(result.score, result.total));
    appendCell(row, result.violations || 0);
    appendCell(row, formatDate(result.submittedAt));
    tbody.appendChild(row);
  });
}

function getFilteredResults(results, search = document.getElementById("resultSearch").value.trim()) {
  const query = search.toLowerCase();
  return results.filter(result =>
    `${result.studentUsername || ""} ${result.student || ""} ${result.assessmentTitle || ""} ${result.subject || ""}`
      .toLowerCase()
      .includes(query)
  );
}

function csvField(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safeText = typeof value !== "number" && /^[\t\r=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
}

function exportResultsCsv() {
  const results = getFilteredResults(loadedResults);
  if (!results.length) return;

  const rows = [
    ["Student username", "Student email", "Assessment", "Subject", "Score", "Total questions", "Page alerts", "Grading status", "Started at", "Submitted at"],
    ...results.map(result => [
      result.studentUsername,
      result.student,
      result.assessmentTitle,
      result.subject,
      result.score,
      result.total,
      result.violations,
      result.gradingStatus,
      result.startedAt,
      result.submittedAt
    ])
  ];
  const csv = `\uFEFF${rows.map(row => row.map(csvField).join(",")).join("\r\n")}`;
  const file = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `examwatch-results-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatDuration(startedAt, submittedAt) {
  const elapsed = Date.parse(submittedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "—";
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function renderHistory(results, activities) {
  const tbody = document.getElementById("historyBody");
  tbody.replaceChildren();
  if (!results.length) {
    makeEmptyRow(tbody, 7, "No assessment history yet", "Completed assessment attempts will appear here.");
    return;
  }
  results.forEach(result => {
    const row = document.createElement("tr");
    appendCell(row, makeStudentCell(result.studentUsername, result.student));
    appendCell(row, result.assessmentTitle || result.subject);
    appendCell(row, scoreChip(result.score, result.total));
    appendCell(row, formatDate(result.startedAt));
    appendCell(row, formatDate(result.submittedAt));
    appendCell(row, formatDuration(result.startedAt, result.submittedAt));
    const details = document.createElement("button");
    details.className = "table-action";
    details.type = "button";
    details.textContent = "View details";
    details.addEventListener("click", () => showHistoryDetails(result, activities));
    appendCell(row, details);
    tbody.appendChild(row);
  });
}

async function showHistoryDetails(result, activities) {
  const dialog = document.getElementById("historyDialog");
  const body = document.getElementById("historyDialogBody");
  const attemptActivities = activities.filter(activity => activity.attemptId === result.attemptId);
  document.getElementById("historyDialogTitle").textContent = result.assessmentTitle || result.subject;
  body.replaceChildren();

  const metadata = document.createElement("div");
  metadata.className = "history-meta";
  [
    ["Username", result.studentUsername],
    ["Student email", result.student],
    ["Score", result.score === null ? "Pending teacher review" : `${result.score} / ${result.total}`],
    ["Grading", result.gradingStatus || "auto_graded"],
    ["Started", formatDate(result.startedAt)],
    ["Submitted", formatDate(result.submittedAt)],
    ["Duration", formatDuration(result.startedAt, result.submittedAt)],
    ["Recorded page/window alerts", result.violations]
  ].forEach(([label, value]) => {
    const item = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = label;
    item.append(heading, document.createTextNode(String(value ?? "—")));
    metadata.appendChild(item);
  });
  body.appendChild(metadata);

  const answersSection = document.createElement("section");
  answersSection.className = "history-detail-section";
  const answersHeading = document.createElement("h3");
  answersHeading.textContent = "Submitted answers";
  const answersList = document.createElement("ol");
  answersList.className = "history-answer-list";
  const questions = result.questions || [];
  const answers = result.answers || [];
  if (!answers.length && !result.submissionImagePath) {
    const empty = document.createElement("li");
    empty.textContent = "Answer details are not available for this attempt.";
    answersList.appendChild(empty);
  } else {
    questions.forEach((question, index) => {
      const item = document.createElement("li");
      const heading = document.createElement("strong");
      heading.textContent = `Question ${index + 1}: ${question?.q || "Question text unavailable"}`;
      const answer = answers[index];
      const response = Number.isInteger(answer) && answer >= 0
        ? `${String.fromCharCode(65 + answer)}${question?.o?.[answer] !== undefined ? `. ${question.o[answer]}` : ""}`
        : answer === undefined && result.submissionImagePath ? "See submitted work photo below." : String(answer || "No answer");
      item.append(heading, document.createTextNode(response));
      if (question?.image_path) {
        const questionImage = document.createElement("img");
        questionImage.alt = `Assessment image for question ${index + 1}`;
        item.appendChild(questionImage);
        setSignedImage(questionImage, question.image_path).catch(error => {
          console.error("[ExamWatch Admin] Could not load assessment image.", error);
          questionImage.alt = "Assessment image could not be loaded.";
        });
      }
      answersList.appendChild(item);
    });
  }
  answersSection.append(answersHeading, answersList);
  body.appendChild(answersSection);

  if (result.submissionImagePath) {
    const submissionSection = document.createElement("section");
    submissionSection.className = "history-detail-section";
    const submissionHeading = document.createElement("h3");
    submissionHeading.textContent = "Student work photo";
    const submissionImage = document.createElement("img");
    submissionImage.className = "submission-preview";
    submissionImage.alt = "Photo of the student's submitted work";
    submissionSection.append(submissionHeading, submissionImage);
    body.appendChild(submissionSection);
    setSignedImage(submissionImage, result.submissionImagePath).catch(error => {
      console.error("[ExamWatch Admin] Could not load submitted work image.", error);
      submissionHeading.textContent = "Student work photo could not be loaded.";
    });

    if (result.gradingStatus === "needs_review") {
      const gradeSection = document.createElement("section");
      gradeSection.className = "history-detail-section";
      const gradeHeading = document.createElement("h3");
      gradeHeading.textContent = "Grade submission";
      const gradeForm = document.createElement("form");
      gradeForm.className = "grade-submission-form";
      const gradeLabel = document.createElement("label");
      gradeLabel.textContent = "Score (0-50 points)";
      const gradeInput = document.createElement("input");
      gradeInput.type = "number";
      gradeInput.min = "0";
      gradeInput.max = "50";
      gradeInput.step = "1";
      gradeInput.required = true;
      gradeLabel.appendChild(gradeInput);
      const gradeButton = document.createElement("button");
      gradeButton.type = "submit";
      gradeButton.className = "button button-primary";
      gradeButton.textContent = "Save grade";
      const gradeMessage = document.createElement("p");
      gradeMessage.setAttribute("role", "status");
      gradeForm.append(gradeLabel, gradeButton);
      gradeForm.addEventListener("submit", async event => {
        event.preventDefault();
        gradeButton.disabled = true;
        gradeMessage.textContent = "";
        try {
          const { error } = await supabaseClient.rpc("grade_examwatch_submission", {
            p_result_id: result.id,
            p_score: Number(gradeInput.value)
          });
          if (error) throw error;
          dialog.close();
          await refreshDashboard();
        } catch (error) {
          console.error("[ExamWatch Admin] Could not grade image submission.", error);
          gradeMessage.textContent = "Hindi na-save ang score. Subukan ulit.";
          gradeButton.disabled = false;
        }
      });
      gradeSection.append(gradeHeading, gradeForm, gradeMessage);
      body.appendChild(gradeSection);
    }
  }

  const activitySection = document.createElement("section");
  activitySection.className = "history-detail-section";
  const activityHeading = document.createElement("h3");
  activityHeading.textContent = "Activity timeline";
  const activityList = document.createElement("ol");
  activityList.className = "history-event-list";
  attemptActivities.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).forEach(activity => {
    const item = document.createElement("li");
    const heading = document.createElement("strong");
    heading.textContent = `${formatDate(activity.at)} · ${activity.label || activity.type}`;
    item.append(heading, document.createTextNode(activity.detail || activity.assessmentTitle || activity.subject || ""));
    activityList.appendChild(item);
  });
  if (!attemptActivities.length) {
    const empty = document.createElement("li");
    empty.textContent = "No detailed activity events were recorded for this attempt.";
    activityList.appendChild(empty);
  }
  activitySection.append(activityHeading, activityList);
  body.appendChild(activitySection);
  dialog.showModal();
}

function renderStats(results, sessions, activities) {
  const studentEmails = new Set([
    ...results.map(result => result.student).filter(Boolean),
    ...sessions.map(session => session.student).filter(Boolean)
  ]);
  document.getElementById("statStudents").textContent = String(studentEmails.size);
  document.getElementById("statTaken").textContent = String(results.length);
  document.getElementById("statLive").textContent = String(sessions.filter(session => session.status === "active" || session.status === "hidden").length);
  document.getElementById("statAlerts").textContent = String(activities.filter(activity => activity.type === "page-hidden").length);
}

async function refreshDashboard() {
  if (adminApp.classList.contains("hidden")) return;
  const [resultsResponse, sessionsResponse, activitiesResponse, assessmentsResponse] = await Promise.all([
    supabaseClient.from("assessment_results")
      .select("id,attempt_id,assessment_id,assessment_title,student_username,student_email,subject,score,total,violations,submitted_answers,submitted_questions,submission_image_path,grading_status,started_at,submitted_at")
      .order("submitted_at", { ascending: false })
      .limit(500),
    supabaseClient.from("live_sessions")
      .select("id,assessment_title,student_username,student_email,subject,status,violations,started_at,last_seen")
      .order("last_seen", { ascending: false })
      .limit(200),
    supabaseClient.from("activity_events")
      .select("attempt_id,assessment_id,assessment_title,student_username,student_email,subject,event_type,label,detail,created_at")
      .order("created_at", { ascending: false })
      .limit(500),
    supabaseClient.from("assessments")
      .select("id,title,subject,duration_minutes,questions,assessment_type,image_layout,shuffle_questions,is_open,closed_at,created_at,updated_at")
      .order("created_at", { ascending: false })
      .limit(500)
  ]);
  const failedResponse = [resultsResponse, sessionsResponse, activitiesResponse, assessmentsResponse].find(response => response.error);
  if (failedResponse) {
    console.error("[ExamWatch Admin] Could not load dashboard data.", failedResponse.error);
    dataStatus.innerHTML = "<strong>Database error:</strong> Could not load records. Check that both setup SQL files ran successfully and this account has the teacher/admin role.";
    return;
  }

  dataStatus.innerHTML = "<strong>Database:</strong> Connected to Supabase. Data refreshes every 5 seconds.";
  const sessionStarts = new Map(sessionsResponse.data.map(session => [session.id, session.started_at]));
  const results = resultsResponse.data.map(result => ({
    id: result.id,
    attemptId: result.attempt_id,
    studentUsername: result.student_username,
    student: result.student_email,
    assessmentTitle: result.assessment_title,
    subject: result.subject,
    score: result.score,
    total: result.total,
    violations: result.violations,
    answers: result.submitted_answers,
    questions: result.submitted_questions,
    submissionImagePath: result.submission_image_path,
    gradingStatus: result.grading_status,
    startedAt: result.started_at || sessionStarts.get(result.attempt_id),
    submittedAt: result.submitted_at
  }));
  loadedResults = results;
  const sessions = sessionsResponse.data
    .filter(session => session.status !== "submitted" && session.status !== "disconnected" &&
      Number.isFinite(Date.parse(session.last_seen)) && Date.now() - Date.parse(session.last_seen) <= ACTIVE_WINDOW_MS)
    .map(session => ({
      studentUsername: session.student_username,
      student: session.student_email,
      assessmentTitle: session.assessment_title,
      subject: session.subject,
      status: session.status,
      violations: session.violations,
      startedAt: session.started_at,
      lastSeen: session.last_seen
    }));
  const activities = activitiesResponse.data.map(activity => ({
    studentUsername: activity.student_username,
    student: activity.student_email,
    attemptId: activity.attempt_id,
    assessmentId: activity.assessment_id,
    assessmentTitle: activity.assessment_title,
    subject: activity.subject,
    type: activity.event_type,
    label: activity.label,
    detail: activity.detail,
    at: activity.created_at
  }));
  const assessments = assessmentsResponse.data;
  renderStats(results, sessions, activities);
  renderRecentResults(results);
  renderLiveLists(sessions);
  renderAssessments(assessments);
  renderActivity(activities);
  renderResults(results);
  renderHistory(results, activities);
}

document.querySelectorAll(".nav-link").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});
document.querySelectorAll("[data-open-page]").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.openPage));
});
document.getElementById("addAssessmentButton").addEventListener("click", () => {
  resetAssessmentForm();
  assessmentDialog.showModal();
});
document.getElementById("addQuestionButton").addEventListener("click", () => addQuestionEditor());
document.getElementById("addImageQuestionButton").addEventListener("click", () => {
  addImageQuestionEditor();
  updateImageLayout();
});
document.getElementById("assessmentTypeInput").addEventListener("change", setAssessmentEditorMode);
document.getElementById("imageLayoutInput").addEventListener("change", updateImageLayout);
document.getElementById("closeAssessmentDialog").addEventListener("click", () => assessmentDialog.close());
document.getElementById("cancelAssessmentButton").addEventListener("click", () => assessmentDialog.close());
assessmentForm.addEventListener("submit", saveAssessment);
document.getElementById("logoutButton").addEventListener("click", async () => {
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    console.error("[ExamWatch Admin] Sign-out failed.", error);
    window.alert("Hindi nakumpleto ang pag-log out. Subukan ulit.");
    return;
  }
  window.location.replace("../Login.html");
});
document.getElementById("resultSearch").addEventListener("input", refreshDashboard);
document.getElementById("exportResultsButton").addEventListener("click", exportResultsCsv);
document.getElementById("closeAssessmentPreview").addEventListener("click", () => assessmentPreviewDialog.close());
document.getElementById("closeHistoryDialog").addEventListener("click", () => {
  document.getElementById("historyDialog").close();
});

async function initializeAdmin() {
  const { data: authData, error: authError } = await supabaseClient.auth.getUser();
  if (authError && authError.name !== "AuthSessionMissingError") {
    console.error("[ExamWatch Admin] Could not verify the current user.", authError);
    window.location.replace("../Login.html?error=connection");
    return;
  }
  if (!authData.user) {
    window.location.replace("../Login.html");
    return;
  }

  const { data: profile, error: profileError } = await supabaseClient
    .from("profiles")
    .select("role")
    .eq("id", authData.user.id)
    .single();
  if (profileError || (profile.role !== "teacher" && profile.role !== "admin")) {
    console.error("[ExamWatch Admin] This account does not have teacher access.", profileError);
    const { error: signOutError } = await supabaseClient.auth.signOut();
    if (signOutError) console.error("[ExamWatch Admin] Could not clear unauthorized session.", signOutError);
    window.location.replace("../Login.html?error=teacher-access");
    return;
  }

  adminApp.classList.remove("hidden");
  await refreshDashboard();
  window.setInterval(() => {
    refreshDashboard().catch(error => {
      console.error("[ExamWatch Admin] Dashboard refresh failed.", error);
      dataStatus.innerHTML = "<strong>Database error:</strong> Could not refresh records. Check your connection.";
    });
  }, 5000);
}

initializeAdmin().catch(error => {
  console.error("[ExamWatch Admin] Could not initialize the admin page.", error);
  window.location.replace("../Login.html?error=connection");
});