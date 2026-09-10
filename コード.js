const SPREADSHEET_ID = '1dDpuYzT9wRAegTDS6JZDqtmBgurI-qWojVrlAnU8S20';
const TEACHER_EMAILS = ['h953420@g.himeji-hyg.ed.jp'];

const SHEETS = {
  LEGACY_STATUS: '提出状況',
  LEGACY_ACCOUNT: 'アカウント',
  STUDENTS: 'Students',
  ASSIGNMENTS: 'Assignments',
  TARGETS: 'AssignmentTargets',
  SUBMISSIONS: 'Submissions',
  AUDIT: 'AuditLog'
};

const HEADERS = {
  Students: ['studentId', 'barcode', 'grade', 'class', 'number', 'name', 'studentEmail', 'parentEmail', 'isActive'],
  Assignments: ['assignmentId', 'date', 'subject', 'title', 'targetGrade', 'targetClass', 'status', 'createdAt', 'createdBy'],
  AssignmentTargets: ['assignmentId', 'studentId', 'barcode', 'targetedAt'],
  Submissions: ['submissionId', 'assignmentId', 'studentId', 'barcode', 'submittedAt', 'method', 'operator', 'status'],
  AuditLog: ['at', 'action', 'assignmentId', 'studentId', 'before', 'after', 'operator']
};

function doGet(e) {
  const email = currentEmail_();
  const isTeacher = TEACHER_EMAILS.includes(email);
  const template = HtmlService.createTemplateFromFile(isTeacher ? 'Index_Teacher' : 'Index_Student');
  template.isTeacher = isTeacher;
  return template.evaluate()
    .setTitle('提出状況確認アプリ')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** ログイン中の児童・保護者本人にひもづく最新データだけを返す。 */
function api_getMyStatus() {
  const email = currentEmail_();
  if (!email) {
    return {
      success: false,
      code: 'EMAIL_UNAVAILABLE',
      message: 'Googleアカウントを確認できません。学校のGoogleアカウントでログインし、Webアプリの公開範囲を「ドメイン内のユーザー」に設定してください。'
    };
  }
  const barcode = findBarcodeByEmail_(email);
  if (!barcode) {
    return {
      success: false,
      code: 'ACCOUNT_NOT_LINKED',
      message: `このGoogleアカウント（${email}）に対応する児童が登録されていません。教師に児童メールまたは保護者メールの登録を依頼してください。`
    };
  }

  if (isPhase1Ready_() && listAssignments_().length) {
    ensureAllAssignmentTargets_();
    const student = listStudents_().find(s => s.barcode === barcode);
    if (!student) {
      return { success: false, code: 'STUDENT_NOT_FOUND', message: `バーコード ${barcode} の児童情報が見つかりません。` };
    }
    const submittedIds = new Set(valuesAsObjects_(getSheet_(SHEETS.SUBMISSIONS))
      .filter(r => String(r.studentId) === student.studentId && String(r.status) === 'SUBMITTED')
      .map(r => String(r.assignmentId)));
    const targetAssignmentIds = new Set(valuesAsObjects_(getSheet_(SHEETS.TARGETS))
      .filter(r => String(r.studentId) === student.studentId)
      .map(r => String(r.assignmentId)));
    const rows = listAssignments_()
      .filter(a => targetAssignmentIds.has(a.assignmentId))
      .map(a => ({
        assignmentId: a.assignmentId, date: a.date, dateLabel: a.dateLabel, subject: a.subject,
        title: a.title, assignmentStatus: a.status, submitted: submittedIds.has(a.assignmentId)
      }));
    return { success: true, email, barcode, name: student.name, rows, fetchedAt: new Date().toISOString() };
  }

  const legacyRows = getLegacyStatusData_().slice(1)
    .filter(r => String(r[3]).trim() === barcode)
    .map((r, index) => ({
      assignmentId: `legacy-${index}`, date: normalizeDate_(r[0]), dateLabel: formatDateLabel_(r[0]),
      subject: '', title: String(r[5] || ''), assignmentStatus: 'CLOSED', submitted: isLegacySubmitted_(r[6])
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
  return { success: true, email, barcode, name: '', rows: legacyRows, fetchedAt: new Date().toISOString() };
}

/** 初回のみ実行。既存データは消さず、新しいシートを追加する。 */
function setupPhase1() {
  assertTeacher_();
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  Object.keys(HEADERS).forEach(name => ensureSheet_(ss, name, HEADERS[name]));
  const imported = importLegacyStudentsIfEmpty_(ss);
  return { success: true, imported, message: imported ? `${imported}人の児童を取り込みました` : '初期設定が完了しました' };
}

/** 旧「提出状況」シートの移行件数を、書き込みなしで確認する。 */
function api_previewLegacyMigration(schoolYear) {
  assertTeacher_();
  ensureReady_();
  const plan = buildLegacyMigrationPlan_(Number(schoolYear));
  return {
    legacyRows: plan.validRows.length,
    assignmentCount: Object.keys(plan.groups).length,
    studentCount: Object.keys(plan.students).length,
    submittedCount: plan.validRows.filter(r => r.submitted).length,
    invalidCount: plan.invalidRows.length,
    invalidExamples: plan.invalidRows.slice(0, 5)
  };
}

/** 旧データを追加移行する。既存データと一致するものは重複登録しない。 */
function api_runLegacyMigration(schoolYear) {
  assertTeacher_();
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const plan = buildLegacyMigrationPlan_(Number(schoolYear));
    if (!plan.validRows.length) throw new Error('移行できるデータがありません。');

    const studentSheet = getSheet_(SHEETS.STUDENTS);
    const existingStudents = listStudents_();
    const studentByBarcode = {};
    existingStudents.forEach(s => studentByBarcode[s.barcode] = s);
    const newStudentRows = [];
    Object.keys(plan.students).forEach(barcode => {
      if (studentByBarcode[barcode]) return;
      const src = plan.students[barcode], parsed = parseBarcode_(barcode);
      const student = {
        studentId: Utilities.getUuid(), barcode, grade: src.grade || parsed.grade,
        class: src.classNo || parsed.classNo, number: parsed.number, name: src.name,
        studentEmail: '', parentEmail: '', isActive: true
      };
      studentByBarcode[barcode] = student;
      newStudentRows.push(objectToRow_(student, HEADERS.Students));
    });
    if (newStudentRows.length) studentSheet.getRange(studentSheet.getLastRow() + 1, 1, newStudentRows.length, HEADERS.Students.length).setValues(newStudentRows);

    const assignmentSheet = getSheet_(SHEETS.ASSIGNMENTS);
    const existingAssignments = listAssignments_();
    const assignmentByKey = {};
    existingAssignments.forEach(a => assignmentByKey[legacyGroupKey_(a.date, a.targetGrade, a.targetClass, a.title)] = a);
    const newAssignmentRows = [];
    Object.keys(plan.groups).forEach(key => {
      if (assignmentByKey[key]) return;
      const src = plan.groups[key];
      const assignment = {
        assignmentId: Utilities.getUuid(), date: src.date, subject: '移行データ', title: src.title,
        targetGrade: src.grade, targetClass: src.classNo, status: 'CLOSED',
        createdAt: new Date(), createdBy: currentEmail_()
      };
      assignment.dateLabel = formatDateLabel_(assignment.date);
      assignmentByKey[key] = assignment;
      newAssignmentRows.push(objectToRow_(assignment, HEADERS.Assignments));
    });
    if (newAssignmentRows.length) assignmentSheet.getRange(assignmentSheet.getLastRow() + 1, 1, newAssignmentRows.length, HEADERS.Assignments.length).setValues(newAssignmentRows);

    const submissionSheet = getSheet_(SHEETS.SUBMISSIONS);
    const existingSubmissionKeys = new Set(valuesAsObjects_(submissionSheet)
      .filter(r => String(r.status) === 'SUBMITTED')
      .map(r => `${r.assignmentId}|${r.studentId}`));
    const newSubmissionRows = [];
    let skipped = 0;
    plan.validRows.filter(r => r.submitted).forEach(r => {
      const assignment = assignmentByKey[r.groupKey], student = studentByBarcode[r.barcode];
      if (!assignment || !student) { skipped++; return; }
      const key = `${assignment.assignmentId}|${student.studentId}`;
      if (existingSubmissionKeys.has(key)) { skipped++; return; }
      existingSubmissionKeys.add(key);
      const record = {
        submissionId: Utilities.getUuid(), assignmentId: assignment.assignmentId, studentId: student.studentId,
        barcode: student.barcode, submittedAt: new Date(`${r.date}T12:00:00`),
        method: 'IMPORT', operator: currentEmail_(), status: 'SUBMITTED'
      };
      newSubmissionRows.push(objectToRow_(record, HEADERS.Submissions));
    });
    if (newSubmissionRows.length) submissionSheet.getRange(submissionSheet.getLastRow() + 1, 1, newSubmissionRows.length, HEADERS.Submissions.length).setValues(newSubmissionRows);

    const result = {
      success: true, addedStudents: newStudentRows.length, addedAssignments: newAssignmentRows.length,
      addedSubmissions: newSubmissionRows.length, skipped, invalid: plan.invalidRows.length
    };
    logAudit_('LEGACY_MIGRATION', '', '', '', JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function api_getBootstrap() {
  assertTeacher_();
  const ready = isPhase1Ready_();
  if (!ready) return { ready: false, email: currentEmail_() };
  ensureAllAssignmentTargets_();
  return {
    ready: true,
    email: currentEmail_(),
    students: listStudents_(),
    assignments: listAssignments_(),
    dashboard: buildDashboard_()
  };
}

function api_saveStudent(data) {
  assertTeacher_();
  ensureReady_();
  const barcode = String(data.barcode || '').trim();
  const name = String(data.name || '').trim();
  if (!/^\d{4}$/.test(barcode)) throw new Error('バーコードは4桁の数字で入力してください。');
  if (!name) throw new Error('児童名を入力してください。');

  const sheet = getSheet_(SHEETS.STUDENTS);
  const rows = valuesAsObjects_(sheet);
  const duplicate = rows.find(r => String(r.barcode) === barcode && String(r.studentId) !== String(data.studentId || ''));
  if (duplicate) throw new Error(`バーコード ${barcode} はすでに使用されています。`);

  const inferred = parseBarcode_(barcode);
  const record = {
    studentId: data.studentId || Utilities.getUuid(),
    barcode,
    grade: Number(data.grade || inferred.grade),
    class: Number(data.class || inferred.classNo),
    number: Number(data.number || inferred.number),
    name,
    studentEmail: String(data.studentEmail || '').trim(),
    parentEmail: String(data.parentEmail || '').trim(),
    isActive: data.isActive !== false
  };

  const rowIndex = rows.findIndex(r => String(r.studentId) === String(record.studentId));
  if (rowIndex >= 0) {
    sheet.getRange(rowIndex + 2, 1, 1, HEADERS.Students.length).setValues([objectToRow_(record, HEADERS.Students)]);
  } else {
    sheet.appendRow(objectToRow_(record, HEADERS.Students));
  }
  logAudit_('SAVE_STUDENT', '', record.studentId, '', JSON.stringify(record));
  return { success: true, student: record };
}

function api_createAssignment(data) {
  assertTeacher_();
  ensureReady_();
  const date = normalizeDate_(data.date);
  const title = String(data.title || '').trim();
  if (!date) throw new Error('提出日を入力してください。');
  if (!title) throw new Error('課題名を入力してください。');

  const record = {
    assignmentId: Utilities.getUuid(),
    date,
    subject: String(data.subject || '').trim(),
    title,
    targetGrade: Number(data.targetGrade),
    targetClass: Number(data.targetClass),
    status: String(data.status || 'OPEN'),
    createdAt: new Date(),
    createdBy: currentEmail_()
  };
  if (!record.targetGrade || !record.targetClass) throw new Error('対象の学年・組を選択してください。');
  getSheet_(SHEETS.ASSIGNMENTS).appendRow(objectToRow_(record, HEADERS.Assignments));
  createAssignmentTargets_(record);
  logAudit_('CREATE_ASSIGNMENT', record.assignmentId, '', '', JSON.stringify(record));
  return { success: true, assignment: serialize_(record) };
}

function api_setAssignmentStatus(assignmentId, status) {
  assertTeacher_();
  ensureReady_();
  if (!['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'].includes(status)) throw new Error('課題の状態が不正です。');
  const sheet = getSheet_(SHEETS.ASSIGNMENTS);
  const rows = valuesAsObjects_(sheet);
  const index = rows.findIndex(r => String(r.assignmentId) === String(assignmentId));
  if (index < 0) throw new Error('課題が見つかりません。');
  const before = rows[index].status;
  sheet.getRange(index + 2, HEADERS.Assignments.indexOf('status') + 1).setValue(status);
  logAudit_('CHANGE_ASSIGNMENT_STATUS', assignmentId, '', before, status);
  return { success: true };
}

function api_scanSubmission(data) {
  const batch = api_scanSubmissionsBatch({ assignmentId: data.assignmentId, barcodes: [data.barcode] });
  const result = batch.results[0] || { success: false, type: 'INVALID', message: '読み取りデータがありません。' };
  result.count = batch.count;
  return result;
}

/** 連続読取用。一度の通信で複数件を検証し、一括保存する。 */
function api_scanSubmissionsBatch(data) {
  assertTeacher_();
  ensureReady_();
  const assignmentId = String(data.assignmentId || '');
  const barcodes = Array.isArray(data.barcodes) ? data.barcodes.slice(0, 100).map(v => String(v || '').trim()) : [];
  if (!barcodes.length) return { results: [], count: submissionCount_(assignmentId) };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const assignment = listAssignments_().find(a => a.assignmentId === assignmentId);
    if (!assignment) return { results: barcodes.map(barcode => ({ barcode, success: false, type: 'NOT_FOUND', message: '課題が見つかりません。' })), count: 0 };
    if (assignment.status !== 'OPEN') return { results: barcodes.map(barcode => ({ barcode, success: false, type: 'CLOSED', message: 'この課題は受付中ではありません。' })), count: submissionCount_(assignmentId) };

    const studentByBarcode = {};
    listStudents_().filter(s => s.isActive).forEach(s => studentByBarcode[s.barcode] = s);
    ensureAllAssignmentTargets_();
    const targetStudentIds = new Set(valuesAsObjects_(getSheet_(SHEETS.TARGETS))
      .filter(r => String(r.assignmentId) === assignmentId)
      .map(r => String(r.studentId)));
    const submissionSheet = getSheet_(SHEETS.SUBMISSIONS);
    const existingStudentIds = new Set(valuesAsObjects_(submissionSheet)
      .filter(r => String(r.assignmentId) === assignmentId && String(r.status) === 'SUBMITTED')
      .map(r => String(r.studentId)));
    const newRows = [], auditRows = [], results = [], now = new Date(), operator = currentEmail_();

    barcodes.forEach(barcode => {
      if (!/^\d{4}$/.test(barcode)) {
        results.push({ barcode, success: false, type: 'INVALID', message: `${barcode || '空欄'}：4桁のバーコードではありません。` });
        return;
      }
      const student = studentByBarcode[barcode];
      if (!student) {
        results.push({ barcode, success: false, type: 'STUDENT_NOT_FOUND', message: `${barcode}：児童が見つかりません。` });
        return;
      }
      if (!targetStudentIds.has(student.studentId)) {
        results.push({ barcode, success: false, type: 'OUT_OF_TARGET', message: `${student.name}さん：この課題の対象ではありません。`, student });
        return;
      }
      if (existingStudentIds.has(student.studentId)) {
        results.push({ barcode, success: false, type: 'DUPLICATE', message: `${student.name}さん：登録済みです。`, student });
        return;
      }
      existingStudentIds.add(student.studentId);
      const record = {
        submissionId: Utilities.getUuid(), assignmentId, studentId: student.studentId, barcode,
        submittedAt: now, method: 'TEACHER', operator, status: 'SUBMITTED'
      };
      newRows.push(objectToRow_(record, HEADERS.Submissions));
      auditRows.push([now, 'SCAN_SUBMISSION', assignmentId, student.studentId, '', 'SUBMITTED', operator]);
      results.push({ barcode, success: true, type: 'SUCCESS', message: `${student.name}さんを登録しました。`, student });
    });

    if (newRows.length) submissionSheet.getRange(submissionSheet.getLastRow() + 1, 1, newRows.length, HEADERS.Submissions.length).setValues(newRows);
    if (auditRows.length) {
      const auditSheet = getSheet_(SHEETS.AUDIT);
      auditSheet.getRange(auditSheet.getLastRow() + 1, 1, auditRows.length, HEADERS.AuditLog.length).setValues(auditRows);
    }
    return { results, count: existingStudentIds.size, saved: newRows.length };
  } finally {
    lock.releaseLock();
  }
}

function api_undoLastSubmission(assignmentId) {
  assertTeacher_();
  ensureReady_();
  const sheet = getSheet_(SHEETS.SUBMISSIONS);
  const rows = valuesAsObjects_(sheet);
  let index = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].assignmentId) === String(assignmentId) && String(rows[i].status) === 'SUBMITTED') { index = i; break; }
  }
  if (index < 0) return { success: false, message: '取り消せる登録がありません。' };
  sheet.getRange(index + 2, HEADERS.Submissions.indexOf('status') + 1).setValue('CANCELLED');
  logAudit_('UNDO_SUBMISSION', assignmentId, rows[index].studentId, 'SUBMITTED', 'CANCELLED');
  const student = listStudents_().find(s => s.studentId === String(rows[index].studentId));
  return { success: true, message: `${student ? student.name : rows[index].barcode}さんの直前登録を取り消しました。`, count: submissionCount_(assignmentId) };
}

function api_getAssignmentStatus(assignmentId) {
  assertTeacher_();
  ensureReady_();
  ensureAllAssignmentTargets_();
  const assignment = listAssignments_().find(a => a.assignmentId === String(assignmentId));
  if (!assignment) throw new Error('課題が見つかりません。');
  const submittedIds = new Set(valuesAsObjects_(getSheet_(SHEETS.SUBMISSIONS))
    .filter(r => String(r.assignmentId) === assignment.assignmentId && String(r.status) === 'SUBMITTED')
    .map(r => String(r.studentId)));
  const targetIds = new Set(valuesAsObjects_(getSheet_(SHEETS.TARGETS))
    .filter(r => String(r.assignmentId) === assignment.assignmentId)
    .map(r => String(r.studentId)));
  const rows = listStudents_()
    .filter(s => targetIds.has(s.studentId))
    .sort((a, b) => Number(a.number) - Number(b.number))
    .map(s => Object.assign({}, s, { submitted: submittedIds.has(s.studentId) }));
  return { assignment, rows, submitted: rows.filter(r => r.submitted).length, total: rows.length };
}

/** 日付・課題・児童を横断して提出状況を確認する教師用一覧。 */
function api_getStatusOverview(filters) {
  assertTeacher_();
  ensureReady_();
  ensureAllAssignmentTargets_();
  filters = filters || {};
  let assignments = listAssignments_();
  if (filters.date) assignments = assignments.filter(a => a.date === String(filters.date));
  if (filters.assignmentId) assignments = assignments.filter(a => a.assignmentId === String(filters.assignmentId));

  const students = listStudents_();
  const studentById = {};
  students.forEach(s => studentById[s.studentId] = s);
  const targetsByAssignment = {};
  valuesAsObjects_(getSheet_(SHEETS.TARGETS)).forEach(r => {
    const id = String(r.assignmentId);
    if (!targetsByAssignment[id]) targetsByAssignment[id] = new Set();
    targetsByAssignment[id].add(String(r.studentId));
  });
  const submittedKeys = new Set(valuesAsObjects_(getSheet_(SHEETS.SUBMISSIONS))
    .filter(r => String(r.status) === 'SUBMITTED')
    .map(r => `${r.assignmentId}|${r.studentId}`));
  let rows = [];
  assignments.forEach(a => {
    Array.from(targetsByAssignment[a.assignmentId] || []).map(id => studentById[id]).filter(Boolean).forEach(s => {
      if (filters.barcode && s.barcode !== String(filters.barcode)) return;
      rows.push({
        assignmentId: a.assignmentId, date: a.date, dateLabel: a.dateLabel, subject: a.subject,
        title: a.title, assignmentStatus: a.status, studentId: s.studentId, barcode: s.barcode,
        grade: s.grade, class: s.class, number: s.number, name: s.name,
        submitted: submittedKeys.has(`${a.assignmentId}|${s.studentId}`)
      });
    });
  });
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'ja') || a.barcode.localeCompare(b.barcode));
  const total = rows.length;
  const submitted = rows.filter(r => r.submitted).length;
  if (filters.missingOnly) rows = rows.filter(r => !r.submitted);
  return { rows, total, submitted, missing: total - submitted, displayed: rows.length };
}

function api_setManualSubmission(data) {
  assertTeacher_();
  ensureReady_();
  const sheet = getSheet_(SHEETS.SUBMISSIONS);
  const rows = valuesAsObjects_(sheet);
  if (data.submitted) {
    const assignment = listAssignments_().find(a => a.assignmentId === String(data.assignmentId));
    const student = listStudents_().find(s => s.barcode === String(data.barcode) && s.isActive);
    if (!assignment || !student) return { success: false, message: '課題または児童が見つかりません。' };
    const exists = rows.some(r => String(r.assignmentId) === assignment.assignmentId && String(r.studentId) === student.studentId && String(r.status) === 'SUBMITTED');
    if (exists) return { success: true };
    const record = {
      submissionId: Utilities.getUuid(), assignmentId: assignment.assignmentId, studentId: student.studentId,
      barcode: student.barcode, submittedAt: new Date(), method: 'MANUAL', operator: currentEmail_(), status: 'SUBMITTED'
    };
    sheet.appendRow(objectToRow_(record, HEADERS.Submissions));
    logAudit_('MANUAL_SUBMIT', assignment.assignmentId, student.studentId, '', `SUBMITTED: ${data.reason || ''}`);
    return { success: true };
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].assignmentId) === String(data.assignmentId) && String(rows[i].barcode) === String(data.barcode) && String(rows[i].status) === 'SUBMITTED') {
      sheet.getRange(i + 2, HEADERS.Submissions.indexOf('status') + 1).setValue('CANCELLED');
      logAudit_('MANUAL_UNSUBMIT', data.assignmentId, rows[i].studentId, 'SUBMITTED', `CANCELLED: ${data.reason || ''}`);
      return { success: true };
    }
  }
  return { success: false, message: '提出記録が見つかりません。' };
}

// 旧画面からの更新にも対応する。
function updateStatus(data) {
  assertTeacher_();
  const assignment = listAssignments_().find(a => a.dateLabel === data.date && a.title === data.task);
  if (assignment) return api_setManualSubmission({ assignmentId: assignment.assignmentId, barcode: data.barcode, submitted: data.status === '〇' });
  return { success: false };
}

function buildDashboard_() {
  const assignments = listAssignments_();
  const students = listStudents_().filter(s => s.isActive);
  const open = assignments.filter(a => a.status === 'OPEN');
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return { studentCount: students.length, openCount: open.length, todayCount: assignments.filter(a => a.date === today).length };
}

function listStudents_() {
  if (!isPhase1Ready_()) return [];
  return valuesAsObjects_(getSheet_(SHEETS.STUDENTS)).map(r => ({
    studentId: String(r.studentId), barcode: String(r.barcode), grade: Number(r.grade), class: Number(r.class),
    number: Number(r.number), name: String(r.name), studentEmail: String(r.studentEmail || ''),
    parentEmail: String(r.parentEmail || ''), isActive: toBool_(r.isActive)
  })).sort((a, b) => a.barcode.localeCompare(b.barcode));
}

function listAssignments_() {
  if (!isPhase1Ready_()) return [];
  return valuesAsObjects_(getSheet_(SHEETS.ASSIGNMENTS)).map(r => ({
    assignmentId: String(r.assignmentId), date: normalizeDate_(r.date), dateLabel: formatDateLabel_(r.date),
    subject: String(r.subject || ''), title: String(r.title), targetGrade: Number(r.targetGrade),
    targetClass: Number(r.targetClass), status: String(r.status)
  })).sort((a, b) => b.date.localeCompare(a.date));
}

function submissionCount_(assignmentId) {
  return valuesAsObjects_(getSheet_(SHEETS.SUBMISSIONS)).filter(r => String(r.assignmentId) === String(assignmentId) && String(r.status) === 'SUBMITTED').length;
}

function getLegacyStatusData_() {
  if (isPhase1Ready_() && listAssignments_().length) {
    const students = listStudents_();
    const submissions = valuesAsObjects_(getSheet_(SHEETS.SUBMISSIONS));
    const result = [['日付', '学年', '組', 'バーコード', '名前', '課題', '提出状況']];
    listAssignments_().filter(a => a.status !== 'ARCHIVED').forEach(a => {
      const submitted = new Set(submissions.filter(s => String(s.assignmentId) === a.assignmentId && String(s.status) === 'SUBMITTED').map(s => String(s.studentId)));
      students.filter(s => s.isActive && s.grade === a.targetGrade && s.class === a.targetClass).forEach(s => {
        result.push([a.date, s.grade, s.class, s.barcode, s.name, a.title, submitted.has(s.studentId) ? '〇' : '未']);
      });
    });
    return result;
  }
  const legacy = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEETS.LEGACY_STATUS);
  return legacy ? legacy.getDataRange().getDisplayValues() : [];
}

function findBarcodeByEmail_(email) {
  email = normalizeEmail_(email);
  if (!email) return '';
  const student = listStudents_().find(s => normalizeEmail_(s.studentEmail) === email || normalizeEmail_(s.parentEmail) === email);
  if (student) return student.barcode;
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEETS.LEGACY_ACCOUNT);
  if (!sheet) return '';
  const row = sheet.getDataRange().getValues().find(r => normalizeEmail_(r[2]) === email || normalizeEmail_(r[3]) === email);
  return row ? String(row[0]).trim() : '';
}

function importLegacyStudentsIfEmpty_(ss) {
  const target = ss.getSheetByName(SHEETS.STUDENTS);
  if (target.getLastRow() > 1) return 0;
  const byBarcode = {};
  const account = ss.getSheetByName(SHEETS.LEGACY_ACCOUNT);
  if (account) account.getDataRange().getValues().slice(1).forEach(r => {
    const code = String(r[0] || '').trim();
    if (/^\d{4}$/.test(code)) byBarcode[code] = { barcode: code, name: String(r[1] || '').trim(), studentEmail: normalizeEmail_(r[2]), parentEmail: normalizeEmail_(r[3]) };
  });
  const legacy = ss.getSheetByName(SHEETS.LEGACY_STATUS);
  if (legacy) legacy.getDataRange().getValues().slice(1).forEach(r => {
    const code = String(r[3] || '').trim();
    if (/^\d{4}$/.test(code) && !byBarcode[code]) byBarcode[code] = { barcode: code, name: String(r[4] || '') };
  });
  const rows = Object.keys(byBarcode).sort().map(code => {
    const parsed = parseBarcode_(code), x = byBarcode[code];
    return [Utilities.getUuid(), code, parsed.grade, parsed.classNo, parsed.number, x.name, x.studentEmail || '', x.parentEmail || '', true];
  });
  if (rows.length) target.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  return rows.length;
}

function buildLegacyMigrationPlan_(schoolYear) {
  if (!Number.isInteger(schoolYear) || schoolYear < 2000 || schoolYear > 2100) throw new Error('年度を西暦4桁で入力してください。');
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEETS.LEGACY_STATUS);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('「提出状況」シートに移行元データがありません。');
  const rows = sheet.getDataRange().getValues().slice(1);
  const validRows = [], invalidRows = [], groups = {}, students = {};
  rows.forEach((r, index) => {
    if (!r.some(v => v !== '')) return;
    const barcode = String(r[3] || '').trim();
    const parsed = /^\d{4}$/.test(barcode) ? parseBarcode_(barcode) : null;
    const date = normalizeLegacyDate_(r[0], schoolYear);
    const grade = Number(r[1] || (parsed && parsed.grade));
    const classNo = Number(r[2] || (parsed && parsed.classNo));
    const name = String(r[4] || '').trim();
    const title = String(r[5] || '').trim();
    if (!date || !parsed || !grade || !classNo || !name || !title) {
      invalidRows.push({ row: index + 2, date: String(r[0] || ''), barcode, name, title });
      return;
    }
    const groupKey = legacyGroupKey_(date, grade, classNo, title);
    const item = { date, grade, classNo, barcode, name, title, groupKey, submitted: isLegacySubmitted_(r[6]) };
    validRows.push(item);
    groups[groupKey] = { date, grade, classNo, title };
    students[barcode] = { barcode, grade, classNo, name };
  });
  return { validRows, invalidRows, groups, students };
}

function legacyGroupKey_(date, grade, classNo, title) {
  return [normalizeDate_(date), Number(grade), Number(classNo), String(title).trim()].join('|');
}

function isLegacySubmitted_(value) {
  const s = String(value == null ? '' : value).trim().toUpperCase();
  return ['〇', '○', '済', '提出済み', 'TRUE', '1'].includes(s);
}

function normalizeLegacyDate_(value, schoolYear) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) return normalizeDate_(value);
  const s = String(value || '').trim();
  if (/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(s)) return normalizeDate_(s.replace(/\//g, '-'));
  let m = s.match(/^(\d{1,2})[月\/\-](\d{1,2})日?$/);
  if (!m) return '';
  const month = Number(m[1]), day = Number(m[2]);
  const year = month >= 4 ? schoolYear : schoolYear + 1;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function ensureTargetsSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  return ensureSheet_(ss, SHEETS.TARGETS, HEADERS.AssignmentTargets);
}

/** 既存課題に対象者が未保存の場合だけ、現在の名簿から一度限り補完する。 */
function ensureAllAssignmentTargets_() {
  const targetSheet = ensureTargetsSheet_();
  const targetedAssignments = new Set(valuesAsObjects_(targetSheet).map(r => String(r.assignmentId)));
  const students = listStudents_().filter(s => s.isActive);
  const rows = [];
  listAssignments_().forEach(a => {
    if (targetedAssignments.has(a.assignmentId)) return;
    students
      .filter(s => s.grade === Number(a.targetGrade) && s.class === Number(a.targetClass))
      .forEach(s => rows.push([a.assignmentId, s.studentId, s.barcode, new Date()]));
  });
  if (rows.length) targetSheet.getRange(targetSheet.getLastRow() + 1, 1, rows.length, HEADERS.AssignmentTargets.length).setValues(rows);
  return rows.length;
}

function createAssignmentTargets_(assignment) {
  const targetSheet = ensureTargetsSheet_();
  const rows = listStudents_()
    .filter(s => s.isActive && s.grade === Number(assignment.targetGrade) && s.class === Number(assignment.targetClass))
    .map(s => [assignment.assignmentId, s.studentId, s.barcode, new Date()]);
  if (rows.length) targetSheet.getRange(targetSheet.getLastRow() + 1, 1, rows.length, HEADERS.AssignmentTargets.length).setValues(rows);
  return rows.length;
}

function ensureReady_() { if (!isPhase1Ready_()) throw new Error('先に「初期設定を実行」を押してください。'); ensureTargetsSheet_(); }
function isPhase1Ready_() { return !!SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEETS.STUDENTS); }
function getSheet_(name) { const s = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name); if (!s) throw new Error(`${name} シートがありません。`); return s; }
function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1d4ed8').setFontColor('#ffffff');
  return sheet;
}
function valuesAsObjects_(sheet) {
  if (sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues(), headers = values[0].map(String);
  return values.slice(1).filter(r => r.some(v => v !== '')).map(r => headers.reduce((o, h, i) => (o[h] = r[i], o), {}));
}
function objectToRow_(obj, headers) { return headers.map(h => obj[h] === undefined ? '' : obj[h]); }
function normalizeEmail_(value) { return String(value || '').trim().toLowerCase(); }
function currentEmail_() { return normalizeEmail_(Session.getActiveUser().getEmail()); }
function assertTeacher_() { if (!TEACHER_EMAILS.includes(currentEmail_())) throw new Error('教師用機能を利用する権限がありません。'); }
function parseBarcode_(code) { return { grade: Number(code[0]), classNo: Number(code[1]), number: Number(code.slice(2)) }; }
function toBool_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || String(v) === '1'; }
function normalizeDate_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s); return isNaN(d) ? '' : Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
function formatDateLabel_(v) { const s = normalizeDate_(v); if (!s) return String(v || ''); const p = s.split('-'); return `${Number(p[1])}月${Number(p[2])}日`; }
function serialize_(obj) { return JSON.parse(JSON.stringify(obj)); }
function logAudit_(action, assignmentId, studentId, before, after) {
  if (!isPhase1Ready_()) return;
  getSheet_(SHEETS.AUDIT).appendRow([new Date(), action, assignmentId, studentId, before, after, currentEmail_()]);
}
