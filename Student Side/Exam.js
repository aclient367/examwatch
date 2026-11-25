async function initializeStudentExam() {
const loginUrl = "../Login.html";
const supabaseClient = window.examwatchSupabase;
const { data: authData, error: authError } = await supabaseClient.auth.getUser();
if (authError || !authData.user) {
  window.location.replace(loginUrl);
  return;
}
const user = authData.user;
const { data: profile, error: profileError } = await supabaseClient
  .from("profiles")
  .select("role,username")
  .eq("id", user.id)
  .single();
if (profileError) throw profileError;
if (profile.role === "teacher" || profile.role === "admin") {
  window.location.replace("../Teacher Side/Admin.html");
  return;
}
if (profile.role !== "student") {
  window.location.replace(loginUrl);
  return;
}
const email = user.email || "Student";
let studentUsername = profile.username || email.split("@")[0] || "Student";
let signingOut = false;
document.getElementById("studentEmail").textContent = email;
document.getElementById("studentUsername").textContent = studentUsername;

const usernameDialog = document.getElementById("usernameDialog");
const usernameForm = document.getElementById("usernameForm");
const usernameInput = document.getElementById("usernameInput");
const usernameMessage = document.getElementById("usernameMessage");
const saveUsernameBtn = document.getElementById("saveUsernameBtn");
document.getElementById("editUsernameBtn").addEventListener("click", () => {
  usernameInput.value = studentUsername;
  usernameMessage.textContent = "";
  usernameDialog.showModal();
  usernameInput.focus();
});
document.getElementById("cancelUsernameBtn").addEventListener("click", () => usernameDialog.close());
usernameForm.addEventListener("submit", async event => {
  event.preventDefault();
  const username = usernameInput.value.trim();
  if (!username || username.length > 40) {
    usernameMessage.textContent = "Maglagay ng username na 1 hanggang 40 characters.";
    return;
  }
  saveUsernameBtn.disabled = true;
  usernameMessage.textContent = "";
  try {
    const { error } = await supabaseClient
      .from("profiles")
      .update({ username })
      .eq("id", user.id);
    if (error) throw error;
    studentUsername = username;
    document.getElementById("studentUsername").textContent = studentUsername;
    usernameDialog.close();
  } catch (error) {
    console.error("[ExamWatch] Could not update student username.", error);
    usernameMessage.textContent = "Hindi na-save ang username. Subukan ulit.";
  } finally {
    saveUsernameBtn.disabled = false;
  }
});

supabaseClient.auth.onAuthStateChange((event, session) => {
  if (event !== "INITIAL_SESSION" && session?.user.id !== user.id) {
    window.location.replace(loginUrl);
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  const s = state[activeAssessmentId];
  if (s && s.started && !s.submitted) {
    await updateMonitoring("disconnected", true, "Student logged out", "Student logged out before submitting the assessment.");
  }
  signingOut = true;
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    signingOut = false;
    console.error("[ExamWatch] Sign-out failed.", error);
    window.alert("Hindi nakumpleto ang pag-log out. Subukan ulit.");
    return;
  }
  window.location.replace(loginUrl);
});

const LETTERS = ["A", "B", "C", "D"];
const monitoringUserId = user.id;
const monitoringEmail = email;
let assessments = [];
const state = {};
const openedAssessmentsStorageKey = `examwatch:opened-assessments:${user.id}`;
let openedAssessmentIds = new Set();
try {
  const savedOpenedAssessments = localStorage.getItem(openedAssessmentsStorageKey);
  if (savedOpenedAssessments) {
    const savedIds = JSON.parse(savedOpenedAssessments);
    if (!Array.isArray(savedIds)) throw new Error("Saved opened assessments are not an array.");
    openedAssessmentIds = new Set(savedIds.filter(id => typeof id === "string"));
  }
} catch (error) {
  console.error("[ExamWatch] Could not restore opened assessments.", error);
}
let activeSubject = "";
let activeAssessmentId = null;
let examVisible = false;
let scoreHistoryVisible = false;
let scoreHistoryLoadRunning = false;
let assessmentPageAway = false;
let timerId = null;
let monitorId = null;

/* ===== ELEMENTS ===== */
const subjectList = document.getElementById("subjectList");
const assessmentPanel = document.getElementById("assessmentPanel");
const assessmentSubject = document.getElementById("assessmentSubject");
const assessmentList = document.getElementById("assessmentList");
const scoreHistoryPanel = document.getElementById("scoreHistoryPanel");
const scoreHistoryList = document.getElementById("scoreHistoryList");
const scoreHistoryMessage = document.getElementById("scoreHistoryMessage");
const scoreHistoryBtn = document.getElementById("scoreHistoryBtn");
const refreshScoreHistoryBtn = document.getElementById("refreshScoreHistoryBtn");
const backToAssessmentsBtn = document.getElementById("backToAssessmentsBtn");
const examPanel = document.getElementById("examPanel");
const examTitle = document.getElementById("examTitle");
const timerEl = document.getElementById("timer");
const qNav = document.getElementById("qNav");
const qNumber = document.getElementById("qNumber");
const qText = document.getElementById("qText");
const optionsEl = document.getElementById("options");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const modal = document.getElementById("modal");

async function loadStudentScoreHistory() {
  if (scoreHistoryLoadRunning) return;
  scoreHistoryLoadRunning = true;
  refreshScoreHistoryBtn.disabled = true;
  scoreHistoryMessage.textContent = "Loading score history...";
  scoreHistoryList.replaceChildren();

  try {
    const { data, error } = await supabaseClient
      .from("assessment_results")
      .select("assessment_title,subject,score,total,grading_status,submitted_at")
      .eq("student_id", user.id)
      .in("grading_status", ["auto_graded", "graded"])
      .not("score", "is", null)
      .order("submitted_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    if (!data.length) {
      scoreHistoryMessage.textContent = "Wala pang graded na assessment. Lalabas dito ang score kapag na-grade na ng teacher.";
      return;
    }

    const fragment = document.createDocumentFragment();
    data.forEach(result => {
      const card = document.createElement("article");
      card.className = "score-history-card";

      const header = document.createElement("div");
      header.className = "score-history-card-heading";
      const title = document.createElement("h3");
      title.textContent = result.assessment_title;
      const score = document.createElement("strong");
      score.className = "score-history-score";
      score.textContent = `${result.score} / ${result.total}`;
      header.append(title, score);

      const details = document.createElement("div");
      details.className = "score-history-details";
      const subject = document.createElement("span");
      subject.textContent = result.subject;
      const submittedAt = document.createElement("time");
      const date = new Date(result.submitted_at);
      if (!Number.isNaN(date.getTime())) {
        submittedAt.dateTime = date.toISOString();
        submittedAt.textContent = date.toLocaleString("fil-PH");
      } else {
        submittedAt.textContent = "Date unavailable";
      }
      details.append(subject, submittedAt);

      const grading = document.createElement("span");
      grading.className = "score-history-status";
      grading.textContent = result.grading_status === "auto_graded" ? "Auto-graded" : "Teacher graded";
      card.append(header, details, grading);
      fragment.appendChild(card);
    });

    scoreHistoryList.appendChild(fragment);
    scoreHistoryMessage.textContent = `${data.length} graded ${data.length === 1 ? "assessment" : "assessments"}.`;
  } catch (error) {
    console.error("[ExamWatch] Could not load student score history.", error);
    scoreHistoryMessage.textContent = "Hindi ma-load ang score history. Patakbuhin ang updated supabase-assessment-management.sql sa Supabase at subukan ulit.";
  } finally {
    refreshScoreHistoryBtn.disabled = false;
    scoreHistoryLoadRunning = false;
  }
}

scoreHistoryBtn.addEventListener("click", () => {
  if (examVisible) return;
  scoreHistoryVisible = true;
  assessmentPanel.classList.add("hidden");
  examPanel.classList.add("hidden");
  scoreHistoryPanel.classList.remove("hidden");
  loadStudentScoreHistory();
});
refreshScoreHistoryBtn.addEventListener("click", loadStudentScoreHistory);
backToAssessmentsBtn.addEventListener("click", () => {
  scoreHistoryVisible = false;
  scoreHistoryPanel.classList.add("hidden");
  renderAssessmentList();
});

/* ===== SIDEBAR ===== */
function renderSubjects() {
  subjectList.innerHTML = "";
  const subjects = [...new Set(assessments.map(assessment => assessment.subject))];
  subjects.forEach(name => {
    const li = document.createElement("li");
    li.textContent = name;
    if (name === activeSubject) li.classList.add("active");
    li.addEventListener("click", () => switchSubject(name));
    subjectList.appendChild(li);
  });
}

function switchSubject(name) {
  if (examVisible && activeAssessmentId) {
    const activeState = state[activeAssessmentId];
    if (activeState.started && !activeState.submitted) {
      updateMonitoring("paused", true, "Assessment paused", "Student returned to the assessment list.");
    }
  }
  clearInterval(timerId);
  clearInterval(monitorId);
  examVisible = false;
  scoreHistoryBtn.disabled = false;
  scoreHistoryVisible = false;
  scoreHistoryPanel.classList.add("hidden");
  activeAssessmentId = null;
  activeSubject = name;
  renderSubjects();
  renderAssessmentList();
}

function markAssessmentOpened(assessmentId) {
  if (openedAssessmentIds.has(assessmentId)) return;
  openedAssessmentIds.add(assessmentId);
  try {
    localStorage.setItem(openedAssessmentsStorageKey, JSON.stringify([...openedAssessmentIds]));
  } catch (error) {
    console.error("[ExamWatch] Could not save opened assessments.", error);
  }
}

function getAssessmentState(assessment) {
  if (!state[assessment.id]) {
    const questionOrder = assessment.questions.map((_, index) => index);
    if (assessment.shuffle_questions) {
      for (let index = questionOrder.length - 1; index > 0; index--) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [questionOrder[index], questionOrder[swapIndex]] = [questionOrder[swapIndex], questionOrder[index]];
      }
    }
    state[assessment.id] = {
      current: 0,
      answers: new Array(assessment.questions.length).fill(assessment.assessment_type === "image_based" ? "" : null),
      questionOrder,
      questions: questionOrder.map(index => assessment.questions[index]),
      answerMode: "text",
      submissionPhoto: null,
      submissionImagePath: null,
      questionImageUrls: [],
      secondsLeft: assessment.duration_minutes * 60,
      started: false,
      submitting: false,
      attemptId: null,
      submitted: false,
      violations: 0
    };
  }
  return state[assessment.id];
}

function renderAssessmentList() {
  assessmentSubject.textContent = activeSubject;
  assessmentList.innerHTML = "";
  const subjectAssessments = assessments.filter(assessment => assessment.subject === activeSubject);
  if (!subjectAssessments.length) {
    const empty = document.createElement("p");
    empty.className = "assessment-empty";
    empty.textContent = "Walang available na assessment para sa subject na ito.";
    assessmentList.appendChild(empty);
  }

  subjectAssessments.forEach(assessment => {
    const s = getAssessmentState(assessment);
    const card = document.createElement("article");
    card.className = "assessment-card";

    const heading = document.createElement("div");
    heading.className = "assessment-card-title";
    const title = document.createElement("h3");
    title.textContent = assessment.title;
    heading.appendChild(title);
    if (!openedAssessmentIds.has(assessment.id)) {
      const unreadDot = document.createElement("span");
      unreadDot.className = "assessment-unopened-dot";
      unreadDot.setAttribute("role", "img");
      unreadDot.setAttribute("aria-label", "Hindi pa nabubuksan");
      heading.appendChild(unreadDot);
    }

    const meta = document.createElement("div");
    meta.className = "assessment-meta";
    const duration = document.createElement("p");
    duration.innerHTML = `<strong>Time frame:</strong> ${assessment.duration_minutes} minutes`;
    const questionCount = document.createElement("p");
    questionCount.innerHTML = `<strong>Questions:</strong> ${assessment.questions.length}`;
    const format = document.createElement("p");
    format.innerHTML = `<strong>Format:</strong> ${assessment.assessment_type === "image_based" ? "Image worksheet" : "Multiple choice"}`;
    meta.append(duration, questionCount, format);

    const button = document.createElement("button");
    button.className = "btn btn-primary";
    button.textContent = s.submitted ? "Completed" : s.started ? "Resume assessment" : assessment.is_open ? "Start assessment" : "Closed";
    button.disabled = s.submitted || s.submitting || (!assessment.is_open && !s.started);
    button.addEventListener("click", async () => {
      if (s.submitted || s.submitting || (!assessment.is_open && !s.started)) return;
      const isResuming = s.started;
      if (!s.attemptId) s.attemptId = crypto.randomUUID();
      s.questions = s.questionOrder.map(index => assessment.questions[index]);
      s.startedAt = s.startedAt || new Date().toISOString();

      if (!isResuming) {
        const { data: startedAt, error } = await supabaseClient.rpc("start_examwatch_assessment", {
          p_assessment_id: assessment.id,
          p_attempt_id: s.attemptId
        });
        if (error) {
          console.error("[ExamWatch] Could not start assessment.", error);
          await loadAssessments();
          showAssessmentNotification("Hindi masimulan ang assessment. Maaaring kaka-close lang nito; i-refresh at tingnan ang status.");
          return;
        }
        s.startedAt = startedAt || s.startedAt;
      }

      if (assessment.assessment_type === "image_based") {
        try {
          s.questionImageUrls = await Promise.all(s.questions.map(async question => {
            const { data, error } = await supabaseClient.storage
              .from("examwatch-assessment-files")
              .createSignedUrl(question.image_path, 21600);
            if (error) throw error;
            return data.signedUrl;
          }));
        } catch (error) {
          showMonitoringError("Could not load assessment images.", error);
          return;
        }
      }

      s.started = true;
      markAssessmentOpened(assessment.id);
      activeAssessmentId = assessment.id;
      examVisible = true;
      scoreHistoryBtn.disabled = true;
      assessmentPageAway = false;
      assessmentPanel.classList.add("hidden");
      examPanel.classList.remove("hidden");
      await updateMonitoring("active", true, isResuming ? "Assessment resumed" : "Assessment started", "Student opened the assessment.");
      clearInterval(monitorId);
      monitorId = setInterval(() => {
        updateMonitoring(assessmentPageAway ? "hidden" : "active", false);
      }, 10000);
      renderExam();
      startTimer();
    });

    card.append(heading, meta);
    if (s.submitted || !assessment.is_open) {
      const status = document.createElement("p");
      status.className = "assessment-status";
      status.textContent = s.submitted ? "Assessment submitted" : "Closed to new attempts";
      card.appendChild(status);
    }
    card.appendChild(button);
    assessmentList.appendChild(card);
  });

  assessmentPanel.classList.remove("hidden");
  examPanel.classList.add("hidden");
}

/* ===== EXAM RENDER ===== */
function renderExam() {
  const s = state[activeAssessmentId];
  const assessment = assessments.find(item => item.id === activeAssessmentId);
  const questions = s.questions;
  const q = questions[s.current];

  examTitle.textContent = `${assessment.subject} • ${assessment.title}`;
  updateTimerText();

  // question pills
  qNav.innerHTML = "";
  questions.forEach((_, i) => {
    const b = document.createElement("button");
    const answered = assessment.assessment_type === "image_based"
      ? s.answerMode === "photo" ? Boolean(s.submissionPhoto) : Boolean(String(s.answers[i] || "").trim())
      : s.answers[i] !== null;
    b.className = "q-pill" + (i === s.current ? " current" : "") + (answered ? " answered" : "");
    b.textContent = i + 1;
    b.addEventListener("click", () => { s.current = i; renderExam(); });
    qNav.appendChild(b);
  });

  qNumber.textContent = `Question ${s.current + 1}`;
  qText.textContent = q.q;

  optionsEl.innerHTML = "";
  if (assessment.assessment_type === "image_based") {
    const questionImage = document.createElement("img");
    questionImage.className = "assessment-question-image";
    questionImage.src = s.questionImageUrls[s.current];
    questionImage.alt = `Assessment image for question ${s.current + 1}`;
    optionsEl.appendChild(questionImage);

    const mode = document.createElement("div");
    mode.className = "answer-mode";
    [
      ["text", "Type answers"],
      ["photo", "Upload a photo of work"]
    ].forEach(([value, labelText]) => {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "answer-mode";
      radio.value = value;
      radio.checked = s.answerMode === value;
      radio.disabled = s.submitted || s.submitting;
      radio.addEventListener("change", () => {
        s.answerMode = value;
        renderExam();
      });
      label.append(radio, document.createTextNode(labelText));
      mode.appendChild(label);
    });
    optionsEl.appendChild(mode);

    if (s.answerMode === "text") {
      const answerInput = document.createElement("textarea");
      answerInput.className = "written-answer";
      answerInput.maxLength = 10000;
      answerInput.placeholder = "I-type ang sagot dito. Awtomatikong iche-check ito laban sa expected answer ng teacher (hindi sensitibo sa malaking/maliit na letra at spaces).";
      answerInput.value = s.answers[s.current] || "";
      answerInput.disabled = s.submitted || s.submitting;
      answerInput.addEventListener("input", () => {
        s.answers[s.current] = answerInput.value;
        qNav.children[s.current]?.classList.toggle("answered", Boolean(answerInput.value.trim()));
      });
      optionsEl.appendChild(answerInput);
    } else {
      const photoInput = document.createElement("input");
      photoInput.className = "work-photo-input";
      photoInput.type = "file";
      photoInput.accept = "image/jpeg,image/png,image/webp";
      photoInput.disabled = s.submitted || s.submitting;
      const photoHelp = document.createElement("p");
      photoHelp.className = "answer-help";
      photoHelp.textContent = s.submissionPhoto
        ? `Napiling larawan: ${s.submissionPhoto.name}. Teacher ang magche-check at magbibigay ng score.`
        : "Mag-upload ng isang larawan ng buong solution mo. Teacher ang magre-review nito.";
      photoInput.addEventListener("change", () => {
        const file = photoInput.files[0];
        if (!file) return;
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) {
          photoInput.value = "";
          showAssessmentNotification("Pumili ng JPG, PNG, o WebP na larawan na hanggang 10 MB.");
          return;
        }
        s.submissionPhoto = file;
        photoHelp.textContent = `Napiling larawan: ${file.name}. Teacher ang magche-check at magbibigay ng score.`;
        qNav.querySelectorAll(".q-pill").forEach(pill => pill.classList.add("answered"));
      });
      optionsEl.appendChild(photoInput);
      optionsEl.appendChild(photoHelp);
    }
  } else {
    q.o.forEach((text, i) => {
      const label = document.createElement("label");
      label.className = "option" + (s.answers[s.current] === i ? " selected" : "");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "opt";
      radio.checked = s.answers[s.current] === i;
      radio.disabled = s.submitted || s.submitting;
      const optionText = document.createElement("span");
      optionText.textContent = `${LETTERS[i]}. ${text}`;
      label.append(radio, optionText);
      label.addEventListener("click", e => {
        e.preventDefault();
        if (s.submitted || s.submitting) return;
        s.answers[s.current] = i;
        const currentAssessment = assessments.find(item => item.id === activeAssessmentId);
        void appendMonitoringRecord({
          attemptId: s.attemptId,
          assessmentId: activeAssessmentId,
          assessmentTitle: currentAssessment.title,
          studentId: monitoringUserId,
          studentEmail: monitoringEmail,
          subject: currentAssessment.subject,
          type: "answer-selected",
          label: `Answered question ${s.current + 1}`,
          detail: `Selected ${LETTERS[i]}: ${text}`,
          at: new Date().toISOString()
        });
        renderExam();
      });
      optionsEl.appendChild(label);
    });
  }

  prevBtn.disabled = s.current === 0;
  const isLast = s.current === questions.length - 1;
  nextBtn.textContent = isLast ? "Submit ✓" : "Next →";
  nextBtn.disabled = s.submitted || s.submitting;
}

/* ===== NAVIGATION ===== */
prevBtn.addEventListener("click", () => {
  const s = state[activeAssessmentId];
  if (s.current > 0) { s.current--; renderExam(); }
});

nextBtn.addEventListener("click", async () => {
  const s = state[activeAssessmentId];
  const total = s.questions.length;
  if (s.current < total - 1) {
    s.current++;
    renderExam();
  } else {
    const assessment = assessments.find(item => item.id === activeAssessmentId);
    const unanswered = assessment.assessment_type === "image_based"
      ? s.answerMode === "photo" ? (s.submissionPhoto ? 0 : total) : s.answers.filter(answer => !String(answer || "").trim()).length
      : s.answers.filter(answer => answer === null).length;
    if (unanswered > 0 && !confirm(`May ${unanswered} na hindi pa nasasagot. Submit na ba?`)) return;
    await submitExam();
  }
});

/* ===== TIMER ===== */
function updateTimerText() {
  const s = state[activeAssessmentId];
  const m = String(Math.floor(s.secondsLeft / 60)).padStart(2, "0");
  const sec = String(s.secondsLeft % 60).padStart(2, "0");
  timerEl.textContent = `${m}:${sec}`;
  timerEl.parentElement.classList.toggle("warning", s.secondsLeft <= 300 && !s.submitted);
}

function startTimer() {
  clearInterval(timerId);
  timerId = setInterval(() => {
    const s = state[activeAssessmentId];
    if (s.submitted || !examVisible) return;
    s.secondsLeft--;
    updateTimerText();
    if (s.secondsLeft <= 0) {
      clearInterval(timerId);
      submitExam(true);
    }
  }, 1000);
}

/* ===== SUBMIT ===== */
async function submitExam(timeUp = false) {
  const s = state[activeAssessmentId];
  if (s.submitted || s.submitting) return;
  const assessment = assessments.find(item => item.id === activeAssessmentId);
  if (assessment.assessment_type === "image_based" && s.answerMode === "photo" && !s.submissionPhoto && !timeUp) {
    window.alert("Pumili muna ng larawan ng solution bago magsumite.");
    return;
  }
  s.submitting = true;
  nextBtn.disabled = true;
  clearInterval(timerId);

  let result;
  let error;
  try {
    if (assessment.assessment_type === "image_based") {
      let submissionImagePath = s.answerMode === "photo" ? s.submissionImagePath : null;
      const textAnswers = new Array(s.answers.length).fill("");
      s.answers.forEach((answer, displayIndex) => {
        textAnswers[s.questionOrder[displayIndex]] = String(answer || "");
      });
      if (s.answerMode === "photo" && s.submissionPhoto && !submissionImagePath) {
        const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" })[s.submissionPhoto.type];
        submissionImagePath = `submissions/${monitoringUserId}/${s.attemptId}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await supabaseClient.storage
          .from("examwatch-assessment-files")
          .upload(submissionImagePath, s.submissionPhoto, {
            contentType: s.submissionPhoto.type,
            upsert: false
          });
        if (uploadError) throw uploadError;
        s.submissionImagePath = submissionImagePath;
      }
      const response = await supabaseClient.rpc("submit_examwatch_image_assessment", {
        p_assessment_id: assessment.id,
        p_attempt_id: s.attemptId,
        p_text_answers: submissionImagePath ? [] : textAnswers,
        p_submission_image_path: submissionImagePath,
        p_violations: s.violations
      });
      result = response.data;
      error = response.error;
    } else {
      const answers = new Array(s.answers.length);
      s.answers.forEach((answer, displayIndex) => {
        answers[s.questionOrder[displayIndex]] = answer;
      });
      const response = await supabaseClient.rpc("submit_examwatch_assessment", {
        p_assessment_id: assessment.id,
        p_attempt_id: s.attemptId,
        p_answers: answers,
        p_violations: s.violations
      });
      result = response.data;
      error = response.error;
    }
  } catch (submitError) {
    error = submitError;
  }
  if (error || !result?.length) {
    showMonitoringError("Could not submit the assessment.", error || new Error("No result returned."));
    s.submitting = false;
    renderExam();
    if (!timeUp) startTimer();
    return;
  }

  s.submitted = true;
  s.submitting = false;
  const { score, total, grading_status: gradingStatus } = result[0];
  const pendingReview = gradingStatus === "needs_review";
  await updateMonitoring(
    "submitted",
    true,
    "Assessment submitted",
    pendingReview ? "Student work photo submitted for teacher review." : `${score} / ${total} correct.`
  );
  clearInterval(monitorId);
  examVisible = false;
  scoreHistoryBtn.disabled = false;

  document.getElementById("modalTitle").textContent = timeUp ? "Time's up!" : "Exam submitted";
  document.getElementById("modalText").textContent = pendingReview
    ? `${assessment.subject} • ${assessment.title}: naisumite ang larawan ng iyong solution at hinihintay ang pag-check ng teacher.`
    : `${assessment.subject} • ${assessment.title}: ${score} / ${total} correct. Flagged activity: ${s.violations}.`;
  modal.classList.remove("hidden");

  renderSubjects();
  renderExam();
}

document.getElementById("modalClose").addEventListener("click", () => modal.classList.add("hidden"));

/* ===== MONITORING (supported browser activity) ===== */
function recordAssessmentPageFocus(isAway, label, detail) {
  if (!activeAssessmentId || assessmentPageAway === isAway) return;
  const s = state[activeAssessmentId];
  if (!s?.started || s.submitted) return;

  assessmentPageAway = isAway;
  if (isAway) s.violations++;
  updateMonitoring(isAway ? "hidden" : "active", true, label, detail);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    recordAssessmentPageFocus(
      true,
      "Assessment page hidden",
      "The browser marked the assessment page as hidden; it cannot identify which page or app was opened."
    );
  } else {
    recordAssessmentPageFocus(false, "Assessment page visible", "Student returned to the assessment page.");
  }
});

window.addEventListener("blur", () => {
  recordAssessmentPageFocus(
    true,
    "Exam window lost focus",
    "The browser window lost focus. This may happen when switching windows or apps; the browser cannot identify what was opened."
  );
});

window.addEventListener("focus", () => {
  if (!document.hidden) {
    recordAssessmentPageFocus(false, "Exam window regained focus", "Student returned to the exam window.");
  }
});

window.addEventListener("pagehide", () => {
  const s = state[activeAssessmentId];
  if (!signingOut && s?.started && !s.submitted) {
    updateMonitoring("disconnected", true, "Assessment page closed", "The assessment page was closed or navigated away.");
  }
});

function showMonitoringError(message, error) {
  console.error(`[ExamWatch] ${message}`, error);
  const notice = document.getElementById("monitoringNotice");
  notice.textContent = `${message} Please check your internet connection and try again.`;
}

async function appendMonitoringRecord(record) {
  try {
    const { error } = await supabaseClient.from("activity_events").insert({
      student_id: record.studentId,
      student_email: record.studentEmail,
      attempt_id: record.attemptId,
      assessment_id: record.assessmentId,
      assessment_title: record.assessmentTitle,
      subject: record.subject,
      event_type: record.type,
      label: record.label,
      detail: record.detail,
      created_at: record.at
    });
    if (error) throw error;
    return true;
  } catch (error) {
    showMonitoringError("Could not save the activity event.", error);
    return false;
  }
}

async function updateMonitoring(status, logEvent, label, detail = "") {
  const s = state[activeAssessmentId];
  if (!s.attemptId) return false;
  const assessment = assessments.find(item => item.id === activeAssessmentId);

  const now = new Date().toISOString();
  try {
    const { error } = await supabaseClient.from("live_sessions").upsert({
      id: s.attemptId,
      assessment_id: activeAssessmentId,
      assessment_title: assessment.title,
      student_id: monitoringUserId,
      student_email: monitoringEmail,
      subject: assessment.subject,
      status,
      violations: s.violations,
      started_at: s.startedAt || now,
      last_seen: now
    }, { onConflict: "id" });
    if (error) throw error;
  } catch (error) {
    showMonitoringError("Could not update the live session.", error);
    return false;
  }

  if (logEvent) {
    return appendMonitoringRecord({
      studentId: monitoringUserId,
      studentEmail: monitoringEmail,
      attemptId: s.attemptId,
      assessmentId: activeAssessmentId,
      assessmentTitle: assessment.title,
      subject: assessment.subject,
      type: status === "hidden" ? "page-hidden" : status === "active" ? "page-visible" : status,
      label: label || status,
      detail,
      at: now
    });
  }
  return true;
}

/* ===== INIT ===== */
const assessmentNotifications = document.getElementById("assessmentNotifications");
let assessmentRefreshRunning = false;

function showAssessmentNotification(message) {
  assessmentNotifications.replaceChildren(document.createTextNode(message));
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => assessmentNotifications.classList.add("hidden"));
  assessmentNotifications.appendChild(dismiss);
  assessmentNotifications.classList.remove("hidden");
}

async function loadAssessments() {
  if (assessmentRefreshRunning) return;
  assessmentRefreshRunning = true;
  try {
    const { data, error } = await supabaseClient
      .from("assessments")
      .select("id,title,subject,duration_minutes,questions,assessment_type,image_layout,shuffle_questions,is_open,closed_at,created_at,updated_at")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;

    assessments = data;

    const subjects = [...new Set(assessments.map(assessment => assessment.subject))];
    if (!subjects.includes(activeSubject)) activeSubject = subjects[0] || "";
    renderSubjects();
    if (!examVisible && !scoreHistoryVisible) renderAssessmentList();
  } finally {
    assessmentRefreshRunning = false;
  }
}

await loadAssessments();
window.setInterval(() => {
  loadAssessments().catch(error => {
    showMonitoringError("Could not refresh the assessment list.", error);
  });
  if (scoreHistoryVisible) loadStudentScoreHistory();
}, 10000);
}

initializeStudentExam().catch(error => {
  console.error("[ExamWatch] Could not initialize the student exam.", error);
  const notification = document.getElementById("assessmentNotifications");
  if (notification) {
    const details = error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
    notification.textContent = `Hindi ma-load ang student dashboard mula sa database. Patakbuhin ang supabase-setup.sql at supabase-assessment-management.sql sa Supabase SQL Editor, saka i-refresh. Detalye: ${details}`;
    notification.classList.add("error");
    notification.classList.remove("hidden");
  }
});