const SPREADSHEET_ID = '1dDpuYzT9wRAegTDS6JZDqtmBgurI-qWojVrlAnU8S20';
const TEACHER_EMAILS = ['h953420@g.himeji-hyg.ed.jp'];
const TEACHER_AUTH_CACHE_KEY = 'HOMEWORK_CHECK_TEACHER_AUTH';
const TEACHER_PASSWORD_PROPERTY = 'HOMEWORK_CHECK_TEACHER_PASSWORD_HASH';
const DEFAULT_TEACHER_PASSWORD = 'teacher';
const DEFAULT_SETTINGS = {
  APP_NAME: 'Homework Check', SCHOOL_NAME: '', DEFAULT_GRADE: '6', DEFAULT_CLASS: '3',
  DEFAULT_SUBJECT: '国語', DEFAULT_ASSIGNMENT_STATUS: 'OPEN', DEFAULT_STATUS_PERIOD: 'MONTH',
  DUTY_DURATION_MINUTES: '120', SCAN_AUTO_SUBMIT: 'TRUE', SCAN_BATCH_SIZE: '50',
  CAMERA_COOLDOWN_MS: '2500', PRINT_TITLE: '宿題提出状況 個票',
  PRINT_DEFAULT_MODE: 'ALL', PRINT_CONFIRMATION: 'TRUE', ABSENCE_COUNTS_AS_MISSING: 'TRUE'
};
const SETTING_DESCRIPTIONS = {
  APP_NAME: 'アプリ名', SCHOOL_NAME: '学校名', DEFAULT_GRADE: '課題登録の初期学年', DEFAULT_CLASS: '課題登録の初期組',
  DEFAULT_SUBJECT: '課題登録の初期教科', DEFAULT_ASSIGNMENT_STATUS: '課題登録の初期受付状態', DEFAULT_STATUS_PERIOD: '提出一覧の初期期間',
  DUTY_DURATION_MINUTES: '当番チェックの初期利用時間（分）', SCAN_AUTO_SUBMIT: '4桁入力時の自動受付', SCAN_BATCH_SIZE: '一度に保存するスキャン件数',
  CAMERA_COOLDOWN_MS: '同じコードを再読取できるまでの時間（ミリ秒）', PRINT_TITLE: '児童個票の表題',
  PRINT_DEFAULT_MODE: '個票の初期表示内容', PRINT_CONFIRMATION: '個票に確認欄を表示',
  ABSENCE_COUNTS_AS_MISSING: '欠席児童を未提出数に含める'
};

const SHEETS = {
  LEGACY_STATUS: '提出状況',
  LEGACY_ACCOUNT: 'アカウント',
  STUDENTS: 'Students',
  ASSIGNMENTS: 'Assignments',
  TARGETS: 'AssignmentTargets',
  DUTY_SESSIONS: 'DutySessions',
  DUTY_MEMBERS: 'DutyMembers',
  SUBMISSIONS: 'Submissions',
  ABSENCES: 'Absences',
  AUDIT: 'AuditLog',
  SETTINGS: 'Settings'
};

const HEADERS = {
  Students: ['studentId', 'barcode', 'grade', 'class', 'number', 'name', 'studentEmail', 'parentEmail', 'isActive'],
  Assignments: ['assignmentId', 'date', 'subject', 'title', 'targetGrade', 'targetClass', 'status', 'createdAt', 'createdBy'],
  AssignmentTargets: ['assignmentId', 'studentId', 'barcode', 'targetedAt'],
  DutySessions: ['dutySessionId', 'assignmentId', 'startsAt', 'endsAt', 'status', 'createdAt', 'createdBy'],
  DutyMembers: ['dutySessionId', 'studentId', 'studentEmail', 'assignedAt'],
  Submissions: ['submissionId', 'assignmentId', 'studentId', 'barcode', 'submittedAt', 'method', 'operator', 'status'],
  Absences: ['absenceId', 'date', 'studentId', 'barcode', 'status', 'recordedAt', 'operator'],
  AuditLog: ['at', 'action', 'assignmentId', 'studentId', 'before', 'after', 'operator'],
  Settings: ['key', 'value', 'description', 'updatedAt', 'updatedBy']
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

/** 教師画面の二段階ログイン状態。Googleアカウントとアプリ内パスワードの両方を確認する。 */
function api_getTeacherLoginState() {
  const email = currentEmail_();
  const allowed = isTeacherAccount_(email);
  return {
    email,
    allowed,
    authenticated: allowed && isTeacherAuthenticated_(),
    usingDefaultPassword: !PropertiesService.getScriptProperties().getProperty(TEACHER_PASSWORD_PROPERTY)
  };
}

function api_loginTeacher(data) {
  const email = currentEmail_();
  const account = normalizeEmail_(data && data.account);
  const password = String(data && data.password || '');
  const cache = CacheService.getUserCache();
  const failureKey = 'HOMEWORK_CHECK_LOGIN_FAILURES';
  const failures = Number(cache.get(failureKey) || 0);
  if (failures >= 5) throw new Error('ログイン失敗が続いたため、5分後にもう一度お試しください。');
  if (!email || account !== email || !isTeacherAccount_(email) || hashTeacherPassword_(password) !== getTeacherPasswordHash_()) {
    cache.put(failureKey, String(failures + 1), 300);
    throw new Error('アカウントまたはパスワードが正しくありません。');
  }
  cache.remove(failureKey);
  cache.put(TEACHER_AUTH_CACHE_KEY, getTeacherPasswordHash_(), 21600);
  return api_getTeacherLoginState();
}

function api_logoutTeacher() {
  CacheService.getUserCache().remove(TEACHER_AUTH_CACHE_KEY);
  return { success: true };
}

function api_changeTeacherPassword(data) {
  assertTeacher_();
  const currentPassword = String(data && data.currentPassword || '');
  const newPassword = String(data && data.newPassword || '');
  if (hashTeacherPassword_(currentPassword) !== getTeacherPasswordHash_()) throw new Error('現在のパスワードが正しくありません。');
  if (newPassword.length < 6) throw new Error('新しいパスワードは6文字以上にしてください。');
  if (newPassword === DEFAULT_TEACHER_PASSWORD) throw new Error('初期パスワードとは別のパスワードを設定してください。');
  const newHash = hashTeacherPassword_(newPassword);
  PropertiesService.getScriptProperties().setProperty(TEACHER_PASSWORD_PROPERTY, newHash);
  CacheService.getUserCache().put(TEACHER_AUTH_CACHE_KEY, newHash, 21600);
  logAudit_('CHANGE_TEACHER_PASSWORD', '', '', '', 'PASSWORD_CHANGED');
  return { success: true };
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
  const access = findStudentAccessByEmail_(email);
  const barcode = access.barcode;
  if (!barcode) {
    return {
      success: false,
      code: 'ACCOUNT_NOT_LINKED',
      message: `このGoogleアカウント（${email}）に対応する児童が登録されていません。教師に児童メールまたは保護者メールの登録を依頼してください。`
    };
  }

  if (isPhase1Ready_() && listAssignments_().length) {
    ensureReady_();
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
    const absenceKeys = getActiveAbsenceKeys_(), settings = getSettings_();
    const rows = listAssignments_()
      .filter(a => targetAssignmentIds.has(a.assignmentId))
      .map(a => ({
        assignmentId: a.assignmentId, date: a.date, dateLabel: a.dateLabel, subject: a.subject,
        title: a.title, assignmentStatus: a.status, submitted: submittedIds.has(a.assignmentId),
        absent: !submittedIds.has(a.assignmentId) && absenceKeys.has(`${a.date}|${student.studentId}`)
      }));
    const dutySessions = access.role === 'STUDENT' ? getActiveDutySessionsFor_(student.studentId, email) : [];
    return { success: true, email, barcode, name: student.name, role: access.role, rows, dutySessions, absenceCountsAsMissing: settings.ABSENCE_COUNTS_AS_MISSING, fetchedAt: new Date().toISOString() };
  }

  const legacyRows = getLegacyStatusData_().slice(1)
    .filter(r => String(r[3]).trim() === barcode)
    .map((r, index) => ({
      assignmentId: `legacy-${index}`, date: normalizeDate_(r[0]), dateLabel: formatDateLabel_(r[0]),
      subject: '', title: String(r[5] || ''), assignmentStatus: 'CLOSED', submitted: isLegacySubmitted_(r[6])
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
  return { success: true, email, barcode, name: '', role: access.role, rows: legacyRows, dutySessions: [], absenceCountsAsMissing: true, fetchedAt: new Date().toISOString() };
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
  ensureReady_();
  ensureAllAssignmentTargets_();
  const settings = getSettings_(), students = listStudents_(), assignments = listAssignments_();
  return {
    ready: true,
    email: currentEmail_(),
    students,
    assignments,
    dashboard: buildDashboard_(assignments, students),
    dashboardDetails: buildDashboardOverview_(settings, assignments, students).assignments,
    duty: getDutyAdminData_(assignments, students),
    settings
  };
}

/** 教師画面から変更できる運用設定を保存する。 */
function api_saveSettings(data) {
  assertTeacher_();
  ensureReady_();
  data = data || {};
  const text = (key, max, fallback) => {
    const value = String(data[key] == null ? fallback : data[key]).trim();
    if (!value || value.length > max) throw new Error(`${SETTING_DESCRIPTIONS[key]}は1～${max}文字で入力してください。`);
    return value;
  };
  const optionalText = (key, max) => {
    const value = String(data[key] == null ? '' : data[key]).trim();
    if (value.length > max) throw new Error(`${SETTING_DESCRIPTIONS[key]}は${max}文字以内で入力してください。`);
    return value;
  };
  const integer = (key, min, max) => {
    const value = Number(data[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${SETTING_DESCRIPTIONS[key]}は${min}～${max}で設定してください。`);
    return String(value);
  };
  const choice = (key, choices) => {
    const value = String(data[key] || '').toUpperCase();
    if (!choices.includes(value)) throw new Error(`${SETTING_DESCRIPTIONS[key]}の値が不正です。`);
    return value;
  };
  const values = {
    APP_NAME: text('APP_NAME', 40, DEFAULT_SETTINGS.APP_NAME),
    SCHOOL_NAME: optionalText('SCHOOL_NAME', 60),
    DEFAULT_GRADE: integer('DEFAULT_GRADE', 1, 6),
    DEFAULT_CLASS: integer('DEFAULT_CLASS', 1, 9),
    DEFAULT_SUBJECT: choice('DEFAULT_SUBJECT', ['国語', '算数', '理科', '社会', '外国語', 'その他']),
    DEFAULT_ASSIGNMENT_STATUS: choice('DEFAULT_ASSIGNMENT_STATUS', ['OPEN', 'DRAFT']),
    DEFAULT_STATUS_PERIOD: choice('DEFAULT_STATUS_PERIOD', ['TODAY', 'WEEK', 'MONTH', 'ALL']),
    DUTY_DURATION_MINUTES: integer('DUTY_DURATION_MINUTES', 15, 480),
    SCAN_AUTO_SUBMIT: data.SCAN_AUTO_SUBMIT === true || String(data.SCAN_AUTO_SUBMIT).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE',
    SCAN_BATCH_SIZE: integer('SCAN_BATCH_SIZE', 1, 100),
    CAMERA_COOLDOWN_MS: integer('CAMERA_COOLDOWN_MS', 500, 10000),
    PRINT_TITLE: text('PRINT_TITLE', 50, DEFAULT_SETTINGS.PRINT_TITLE),
    PRINT_DEFAULT_MODE: choice('PRINT_DEFAULT_MODE', ['ALL', 'MISSING']),
    PRINT_CONFIRMATION: data.PRINT_CONFIRMATION === true || String(data.PRINT_CONFIRMATION).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE',
    ABSENCE_COUNTS_AS_MISSING: data.ABSENCE_COUNTS_AS_MISSING === true || String(data.ABSENCE_COUNTS_AS_MISSING).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE'
  };
  const sheet = getSheet_(SHEETS.SETTINGS), existing = valuesAsObjects_(sheet), byKey = {};
  existing.forEach(r => byKey[String(r.key)] = r);
  const now = new Date(), operator = currentEmail_();
  Object.keys(values).forEach(key => byKey[key] = { key, value: values[key], description: SETTING_DESCRIPTIONS[key] || '', updatedAt: now, updatedBy: operator });
  const rows = Object.keys(byKey).map(key => objectToRow_(byKey[key], HEADERS.Settings));
  const clearRows = Math.max(sheet.getLastRow() - 1, rows.length);
  if (clearRows) sheet.getRange(2, 1, clearRows, HEADERS.Settings.length).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, HEADERS.Settings.length).setValues(rows);
  logAudit_('SAVE_SETTINGS', '', '', '', JSON.stringify(values));
  return { success: true, settings: getSettings_() };
}

function api_createDutySession(data) {
  data = data || {};
  data.assignmentIds = [data.assignmentId];
  return api_createDutySessions(data);
}

/** 複数課題を、同じ当番児童と終了時刻でまとめて割り当てる。 */
function api_createDutySessions(data) {
  assertTeacher_();
  ensureReady_();
  const assignmentIds = Array.from(new Set(Array.isArray(data.assignmentIds) ? data.assignmentIds.map(String) : [])).slice(0, 30);
  if (!assignmentIds.length) throw new Error('課題を1件以上選択してください。');
  const assignmentById = {};
  listAssignments_().forEach(a => assignmentById[a.assignmentId] = a);
  const assignments = assignmentIds.map(id => assignmentById[id]).filter(Boolean);
  if (assignments.length !== assignmentIds.length) throw new Error('選択した課題の一部が見つかりません。画面を更新してください。');
  const unavailableAssignments = assignments.filter(a => a.status !== 'OPEN');
  if (unavailableAssignments.length) throw new Error(`受付中ではない課題があります：${unavailableAssignments.map(a => a.title).join('、')}`);
  const studentIds = Array.from(new Set(Array.isArray(data.studentIds) ? data.studentIds.map(String) : []));
  if (!studentIds.length) throw new Error('当番児童を1人以上選択してください。');
  const students = listStudents_().filter(s => studentIds.includes(s.studentId));
  if (students.length !== studentIds.length) throw new Error('選択した児童の一部が見つかりません。画面を更新してください。');
  const unavailable = students.filter(s => !normalizeEmail_(s.studentEmail));
  if (unavailable.length) throw new Error(`児童メールが未登録です：${unavailable.map(s => s.name).join('、')}`);
  const endsAt = new Date(data.endsAt);
  if (isNaN(endsAt) || endsAt <= new Date()) throw new Error('終了時刻を現在より後に設定してください。');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const now = new Date(), operator = currentEmail_();
    const sessions = assignments.map(a => ({ dutySessionId: Utilities.getUuid(), assignmentId: a.assignmentId }));
    const sessionRows = sessions.map(s => [s.dutySessionId, s.assignmentId, now, endsAt, 'OPEN', now, operator]);
    const sessionSheet = getSheet_(SHEETS.DUTY_SESSIONS);
    sessionSheet.getRange(sessionSheet.getLastRow() + 1, 1, sessionRows.length, HEADERS.DutySessions.length).setValues(sessionRows);
    const memberRows = [];
    sessions.forEach(session => students.forEach(s => memberRows.push([session.dutySessionId, s.studentId, normalizeEmail_(s.studentEmail), now])));
    const memberSheet = getSheet_(SHEETS.DUTY_MEMBERS);
    memberSheet.getRange(memberSheet.getLastRow() + 1, 1, memberRows.length, HEADERS.DutyMembers.length).setValues(memberRows);
    const auditRows = sessions.map(s => [now, 'CREATE_DUTY_SESSION', s.assignmentId, '', '', JSON.stringify({ dutySessionId: s.dutySessionId, studentIds, assignmentCount: sessions.length }), operator]);
    const auditSheet = getSheet_(SHEETS.AUDIT);
    auditSheet.getRange(auditSheet.getLastRow() + 1, 1, auditRows.length, HEADERS.AuditLog.length).setValues(auditRows);
    return { success: true, createdCount: sessions.length, duty: getDutyAdminData_() };
  } finally {
    lock.releaseLock();
  }
}

function api_closeDutySession(dutySessionId) {
  assertTeacher_();
  ensureReady_();
  const sheet = getSheet_(SHEETS.DUTY_SESSIONS), rows = valuesAsObjects_(sheet);
  const index = rows.findIndex(r => String(r.dutySessionId) === String(dutySessionId));
  if (index < 0) throw new Error('当番セッションが見つかりません。');
  sheet.getRange(index + 2, HEADERS.DutySessions.indexOf('status') + 1).setValue('CLOSED');
  logAudit_('CLOSE_DUTY_SESSION', rows[index].assignmentId, '', 'OPEN', 'CLOSED');
  return { success: true, duty: getDutyAdminData_() };
}

function api_scanDutyBatch(data) {
  ensureReady_();
  const email = currentEmail_();
  if (!email) throw new Error('学校のGoogleアカウントを確認できません。');
  const session = getDutySession_(data.dutySessionId);
  if (!session || !isDutySessionOpen_(session)) throw new Error('この当番チェックは終了しています。');
  const member = valuesAsObjects_(getSheet_(SHEETS.DUTY_MEMBERS)).find(r =>
    String(r.dutySessionId) === String(session.dutySessionId) && normalizeEmail_(r.studentEmail) === email
  );
  if (!member) throw new Error('この課題の当番には指定されていません。');
  return scanSubmissionsBatch_(session.assignmentId, data.barcodes, email, 'DUTY_CAMERA');
}

function api_saveStudent(data) {
  assertTeacher_();
  ensureReady_();
  const name = String(data.name || '').trim();
  if (!name) throw new Error('児童名を入力してください。');
  const grade = Number(data.grade), classNo = Number(data.class), number = Number(data.number);
  if (!Number.isInteger(grade) || grade < 1 || grade > 6) throw new Error('学年は1～6で入力してください。');
  if (!Number.isInteger(classNo) || classNo < 1 || classNo > 9) throw new Error('組は1～9で入力してください。');
  if (!Number.isInteger(number) || number < 1 || number > 99) throw new Error('出席番号は1～99で入力してください。');
  const barcode = `${grade}${classNo}${String(number).padStart(2, '0')}`;

  const sheet = getSheet_(SHEETS.STUDENTS);
  const rows = valuesAsObjects_(sheet);
  const duplicate = rows.find(r => String(r.barcode) === barcode && String(r.studentId) !== String(data.studentId || ''));
  if (duplicate) throw new Error(`バーコード ${barcode} はすでに使用されています。`);

  const record = {
    studentId: data.studentId || Utilities.getUuid(),
    barcode,
    grade,
    class: classNo,
    number,
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

/** 複数課題を一度に登録する。課題・対象児童・監査ログをそれぞれ一括書込する。 */
function api_createAssignmentsBatch(data) {
  assertTeacher_();
  ensureReady_();
  const date = normalizeDate_(data && data.date);
  const targetGrade = Number(data && data.targetGrade);
  const targetClass = Number(data && data.targetClass);
  const status = String(data && data.status || 'OPEN');
  const items = Array.isArray(data && data.items) ? data.items.slice(0, 30) : [];
  if (!date) throw new Error('提出日を入力してください。');
  if (!targetGrade || !targetClass) throw new Error('対象の学年・組を選択してください。');
  if (!['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'].includes(status)) throw new Error('課題の状態が不正です。');
  const cleaned = items.map(x => ({ subject: String(x.subject || '').trim(), title: String(x.title || '').trim() })).filter(x => x.title);
  if (!cleaned.length) throw new Error('課題を1件以上入力してください。');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const duplicateKeys = new Set(listAssignments_().map(a => [a.date, a.targetGrade, a.targetClass, a.title].join('|')));
    const localKeys = new Set(), now = new Date(), operator = currentEmail_();
    const created = [], skipped = [];
    cleaned.forEach(item => {
      const key = [date, targetGrade, targetClass, item.title].join('|');
      if (duplicateKeys.has(key) || localKeys.has(key)) {
        skipped.push(item.title);
        return;
      }
      localKeys.add(key);
      created.push({
        assignmentId: Utilities.getUuid(), date, subject: item.subject, title: item.title,
        targetGrade, targetClass, status, createdAt: now, createdBy: operator
      });
    });
    if (!created.length) return { success: true, created: [], skipped, message: '同じ課題がすでに登録されています。' };

    const assignmentSheet = getSheet_(SHEETS.ASSIGNMENTS);
    assignmentSheet.getRange(assignmentSheet.getLastRow() + 1, 1, created.length, HEADERS.Assignments.length)
      .setValues(created.map(r => objectToRow_(r, HEADERS.Assignments)));
    const students = listStudents_().filter(s => s.isActive && s.grade === targetGrade && s.class === targetClass);
    const targetRows = [];
    created.forEach(a => students.forEach(s => targetRows.push([a.assignmentId, s.studentId, s.barcode, now])));
    if (targetRows.length) {
      const targetSheet = getSheet_(SHEETS.TARGETS);
      targetSheet.getRange(targetSheet.getLastRow() + 1, 1, targetRows.length, HEADERS.AssignmentTargets.length).setValues(targetRows);
    }
    const auditRows = created.map(a => [now, 'CREATE_ASSIGNMENT_BATCH', a.assignmentId, '', '', JSON.stringify(a), operator]);
    const auditSheet = getSheet_(SHEETS.AUDIT);
    auditSheet.getRange(auditSheet.getLastRow() + 1, 1, auditRows.length, HEADERS.AuditLog.length).setValues(auditRows);
    return { success: true, created: serialize_(created), skipped };
  } finally {
    lock.releaseLock();
  }
}

/** 既存課題を編集する。提出履歴がある課題の対象クラス変更は整合性保護のため許可しない。 */
function api_updateAssignment(data) {
  assertTeacher_();
  ensureReady_();
  const assignmentId = String(data.assignmentId || '');
  const date = normalizeDate_(data.date);
  const title = String(data.title || '').trim();
  const status = String(data.status || 'OPEN');
  if (!assignmentId) throw new Error('課題IDがありません。');
  if (!date) throw new Error('提出日を入力してください。');
  if (!title) throw new Error('課題名を入力してください。');
  if (!['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'].includes(status)) throw new Error('課題の状態が不正です。');

  const sheet = getSheet_(SHEETS.ASSIGNMENTS);
  const rows = valuesAsObjects_(sheet);
  const index = rows.findIndex(r => String(r.assignmentId) === assignmentId);
  if (index < 0) throw new Error('課題が見つかりません。');
  const before = rows[index];
  const record = {
    assignmentId,
    date,
    subject: String(data.subject || '').trim(),
    title,
    targetGrade: Number(data.targetGrade),
    targetClass: Number(data.targetClass),
    status,
    createdAt: before.createdAt,
    createdBy: before.createdBy
  };
  if (!record.targetGrade || !record.targetClass) throw new Error('対象の学年・組を選択してください。');

  const targetChanged = Number(before.targetGrade) !== record.targetGrade || Number(before.targetClass) !== record.targetClass;
  if (targetChanged) {
    const hasSubmissionHistory = valuesAsObjects_(getSheet_(SHEETS.SUBMISSIONS)).some(r => String(r.assignmentId) === assignmentId);
    const hasDutyHistory = valuesAsObjects_(getSheet_(SHEETS.DUTY_SESSIONS)).some(r => String(r.assignmentId) === assignmentId);
    if (hasSubmissionHistory || hasDutyHistory) {
      throw new Error('提出記録または当番設定があるため、対象学年・組は変更できません。日付・課題名などは変更できます。');
    }
  }

  sheet.getRange(index + 2, 1, 1, HEADERS.Assignments.length).setValues([objectToRow_(record, HEADERS.Assignments)]);
  if (targetChanged) {
    deleteDataRowsWhere_(SHEETS.TARGETS, r => String(r.assignmentId) === assignmentId);
    createAssignmentTargets_(record);
  }
  logAudit_('UPDATE_ASSIGNMENT', assignmentId, '', JSON.stringify(before), JSON.stringify(record));
  record.dateLabel = formatDateLabel_(record.date);
  return { success: true, assignment: serialize_(record) };
}

/** 課題削除前に、同時に削除される関連データ件数を返す。 */
function api_getAssignmentDeleteImpact(assignmentIdValue) {
  assertTeacher_();
  ensureReady_();
  const assignmentId = String(assignmentIdValue || '');
  const assignment = listAssignments_().find(a => a.assignmentId === assignmentId);
  if (!assignment) throw new Error('課題が見つかりません。');
  const sessions = valuesAsObjects_(getSheet_(SHEETS.DUTY_SESSIONS)).filter(r => String(r.assignmentId) === assignmentId);
  const sessionIds = new Set(sessions.map(r => String(r.dutySessionId)));
  const submissions = valuesAsObjects_(getSheet_(SHEETS.SUBMISSIONS)).filter(r => String(r.assignmentId) === assignmentId);
  return {
    assignment,
    targetCount: valuesAsObjects_(getSheet_(SHEETS.TARGETS)).filter(r => String(r.assignmentId) === assignmentId).length,
    submittedCount: submissions.filter(r => String(r.status) === 'SUBMITTED').length,
    submissionHistoryCount: submissions.length,
    dutySessionCount: sessions.length,
    dutyMemberCount: valuesAsObjects_(getSheet_(SHEETS.DUTY_MEMBERS)).filter(r => sessionIds.has(String(r.dutySessionId))).length
  };
}

/** 課題と関連データをまとめて削除する。課題名の再確認で誤操作を防ぐ。 */
function api_deleteAssignment(data) {
  assertTeacher_();
  ensureReady_();
  const assignmentId = String(data.assignmentId || '');
  const impact = api_getAssignmentDeleteImpact(assignmentId);
  if (String(data.confirmTitle || '') !== impact.assignment.title) throw new Error('確認用の課題名が一致しません。');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sessions = valuesAsObjects_(getSheet_(SHEETS.DUTY_SESSIONS)).filter(r => String(r.assignmentId) === assignmentId);
    const sessionIds = new Set(sessions.map(r => String(r.dutySessionId)));
    deleteDataRowsWhere_(SHEETS.DUTY_MEMBERS, r => sessionIds.has(String(r.dutySessionId)));
    deleteDataRowsWhere_(SHEETS.DUTY_SESSIONS, r => String(r.assignmentId) === assignmentId);
    deleteDataRowsWhere_(SHEETS.SUBMISSIONS, r => String(r.assignmentId) === assignmentId);
    deleteDataRowsWhere_(SHEETS.TARGETS, r => String(r.assignmentId) === assignmentId);
    deleteDataRowsWhere_(SHEETS.ASSIGNMENTS, r => String(r.assignmentId) === assignmentId);
    logAudit_('DELETE_ASSIGNMENT', assignmentId, '', JSON.stringify(impact.assignment), JSON.stringify(impact));
    return { success: true, deleted: impact };
  } finally {
    lock.releaseLock();
  }
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

/** 今日の状況から、複数の受付中課題をまとめて停止する。 */
function api_closeAssignmentsBatch(data) {
  assertTeacher_();
  ensureReady_();
  data = data || {};
  const assignmentIds = [...new Set((data.assignmentIds || []).map(String).filter(Boolean))];
  if (!assignmentIds.length) throw new Error('受付停止する課題を選択してください。');
  if (assignmentIds.length > 200) throw new Error('一度に停止できる課題は200件までです。');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSheet_(SHEETS.ASSIGNMENTS), rows = valuesAsObjects_(sheet);
    const wanted = new Set(assignmentIds), targets = [];
    rows.forEach((row, index) => {
      if (wanted.has(String(row.assignmentId))) targets.push({ row: index + 2, assignmentId: String(row.assignmentId), status: String(row.status) });
    });
    if (targets.length !== assignmentIds.length) throw new Error('選択した課題の一部が見つかりません。画面を更新してやり直してください。');
    const unavailable = targets.filter(target => target.status !== 'OPEN');
    if (unavailable.length) throw new Error('既に受付停止された課題が含まれています。画面を更新してやり直してください。');
    const statusColumn = HEADERS.Assignments.indexOf('status') + 1;
    sheet.getRangeList(targets.map(target => `${columnLetter_(statusColumn)}${target.row}`)).setValue('CLOSED');
    const now = new Date(), operator = currentEmail_(), auditSheet = getSheet_(SHEETS.AUDIT);
    const auditRows = targets.map(target => [now, 'BATCH_CLOSE_ASSIGNMENT', target.assignmentId, '', 'OPEN', 'CLOSED', operator]);
    auditSheet.getRange(auditSheet.getLastRow() + 1, 1, auditRows.length, HEADERS.AuditLog.length).setValues(auditRows);
    return { success: true, closedCount: targets.length, assignmentIds: targets.map(target => target.assignmentId) };
  } finally {
    lock.releaseLock();
  }
}

/** 課題管理から、選択した課題の状態をまとめて変更する。 */
function api_setAssignmentStatusesBatch(data) {
  assertTeacher_();
  ensureReady_();
  data = data || {};
  const assignmentIds = [...new Set((data.assignmentIds || []).map(String).filter(Boolean))];
  const status = String(data.status || '').toUpperCase();
  if (!assignmentIds.length) throw new Error('変更する課題を選択してください。');
  if (!['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'].includes(status)) throw new Error('課題の状態が不正です。');
  if (assignmentIds.length > 500) throw new Error('一度に変更できる課題は500件までです。');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSheet_(SHEETS.ASSIGNMENTS), rows = valuesAsObjects_(sheet), wanted = new Set(assignmentIds), targets = [];
    rows.forEach((row, index) => {
      if (wanted.has(String(row.assignmentId))) targets.push({ row: index + 2, assignmentId: String(row.assignmentId), before: String(row.status) });
    });
    if (targets.length !== assignmentIds.length) throw new Error('選択した課題の一部が見つかりません。画面を更新してやり直してください。');
    const changed = targets.filter(target => target.before !== status);
    if (changed.length) {
      const statusColumn = HEADERS.Assignments.indexOf('status') + 1;
      sheet.getRangeList(changed.map(target => `${columnLetter_(statusColumn)}${target.row}`)).setValue(status);
      const now = new Date(), operator = currentEmail_(), auditSheet = getSheet_(SHEETS.AUDIT);
      const auditRows = changed.map(target => [now, 'BATCH_CHANGE_ASSIGNMENT_STATUS', target.assignmentId, '', target.before, status, operator]);
      auditSheet.getRange(auditSheet.getLastRow() + 1, 1, auditRows.length, HEADERS.AuditLog.length).setValues(auditRows);
    }
    return { success: true, requestedCount: targets.length, changedCount: changed.length, status };
  } finally {
    lock.releaseLock();
  }
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
  return scanSubmissionsBatch_(data.assignmentId, data.barcodes, currentEmail_(), 'TEACHER');
}

function scanSubmissionsBatch_(assignmentIdValue, barcodeValues, operator, method) {
  ensureReady_();
  const assignmentId = String(assignmentIdValue || '');
  const barcodes = Array.isArray(barcodeValues) ? barcodeValues.slice(0, 100).map(v => String(v || '').trim()) : [];
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
    const newRows = [], auditRows = [], results = [], now = new Date();

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
        submittedAt: now, method, operator, status: 'SUBMITTED'
      };
      newRows.push(objectToRow_(record, HEADERS.Submissions));
      auditRows.push([now, method === 'DUTY_CAMERA' ? 'DUTY_SCAN_SUBMISSION' : 'SCAN_SUBMISSION', assignmentId, student.studentId, '', 'SUBMITTED', operator]);
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

/** 「今日の状況」用。受付中課題の提出数と未提出児童を一括取得する。 */
function api_getDashboardOverview() {
  assertTeacher_();
  ensureReady_();
  ensureAllAssignmentTargets_();
  return buildDashboardOverview_(getSettings_());
}

function buildDashboardOverview_(settings, assignmentRows, studentRows) {
  const assignments = (assignmentRows || listAssignments_()).filter(a => a.status === 'OPEN');
  const assignmentIds = new Set(assignments.map(a => a.assignmentId));
  const studentsById = {};
  (studentRows || listStudents_()).filter(s => s.isActive).forEach(s => studentsById[s.studentId] = s);
  const targetsByAssignment = {};
  valuesAsObjects_(getSheet_(SHEETS.TARGETS)).forEach(row => {
    const assignmentId = String(row.assignmentId), studentId = String(row.studentId);
    if (!assignmentIds.has(assignmentId) || !studentsById[studentId]) return;
    if (!targetsByAssignment[assignmentId]) targetsByAssignment[assignmentId] = [];
    targetsByAssignment[assignmentId].push(studentId);
  });
  const submittedKeys = new Set(valuesAsObjects_(getSheet_(SHEETS.SUBMISSIONS))
    .filter(row => String(row.status) === 'SUBMITTED' && assignmentIds.has(String(row.assignmentId)))
    .map(row => `${row.assignmentId}|${row.studentId}`));
  const absenceKeys = getActiveAbsenceKeys_();
  const result = assignments.map(assignment => {
    const students = (targetsByAssignment[assignment.assignmentId] || []).map(id => studentsById[id]).filter(Boolean)
      .sort((a, b) => Number(a.number) - Number(b.number));
    const missingStudents = students.filter(student => !submittedKeys.has(`${assignment.assignmentId}|${student.studentId}`))
      .map(student => ({ studentId: student.studentId, barcode: student.barcode, number: student.number, name: student.name, absent: absenceKeys.has(`${assignment.date}|${student.studentId}`) }));
    const absent = missingStudents.filter(student => student.absent).length;
    const missing = settings.ABSENCE_COUNTS_AS_MISSING ? missingStudents.length : missingStudents.length - absent;
    return Object.assign({}, assignment, {
      total: students.length,
      submitted: students.length - missingStudents.length,
      absent,
      excluded: settings.ABSENCE_COUNTS_AS_MISSING ? 0 : absent,
      missing,
      missingStudents
    });
  });
  return { assignments: result, absenceCountsAsMissing: settings.ABSENCE_COUNTS_AS_MISSING, fetchedAt: new Date() };
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
  const absenceKeys = getActiveAbsenceKeys_(), settings = getSettings_();
  let rows = [];
  assignments.forEach(a => {
    Array.from(targetsByAssignment[a.assignmentId] || []).map(id => studentById[id]).filter(Boolean).forEach(s => {
      if (filters.barcode && s.barcode !== String(filters.barcode)) return;
      rows.push({
        assignmentId: a.assignmentId, date: a.date, dateLabel: a.dateLabel, subject: a.subject,
        title: a.title, assignmentStatus: a.status, studentId: s.studentId, barcode: s.barcode,
        grade: s.grade, class: s.class, number: s.number, name: s.name,
        submitted: submittedKeys.has(`${a.assignmentId}|${s.studentId}`),
        absent: !submittedKeys.has(`${a.assignmentId}|${s.studentId}`) && absenceKeys.has(`${a.date}|${s.studentId}`)
      });
    });
  });
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'ja') || a.barcode.localeCompare(b.barcode));
  const total = rows.length;
  const submitted = rows.filter(r => r.submitted).length;
  const absent = rows.filter(r => r.absent).length;
  const missing = rows.filter(r => !r.submitted && (settings.ABSENCE_COUNTS_AS_MISSING || !r.absent)).length;
  if (filters.missingOnly) rows = rows.filter(r => !r.submitted);
  return { rows, total, submitted, absent, missing, displayed: rows.length, absenceCountsAsMissing: settings.ABSENCE_COUNTS_AS_MISSING };
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

/** 児童の欠席を日付単位で記録・解除する。 */
function api_setAbsencesBatch(data) {
  assertTeacher_();
  ensureReady_();
  data = data || {};
  const date = normalizeDate_(data.date), absent = data.absent !== false;
  const barcodes = [...new Set((data.barcodes || []).map(value => String(value).trim()).filter(value => /^\d{4}$/.test(value)))].slice(0, 200);
  if (!date) throw new Error('欠席日を指定してください。');
  if (!barcodes.length) throw new Error('欠席を記録する児童を選択してください。');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const studentsByBarcode = {};
    listStudents_().filter(student => student.isActive).forEach(student => studentsByBarcode[student.barcode] = student);
    const unknown = barcodes.filter(barcode => !studentsByBarcode[barcode]);
    if (unknown.length) throw new Error(`児童情報が見つかりません：${unknown.join('、')}`);
    const activeKeys = getActiveAbsenceKeys_(), now = new Date(), operator = currentEmail_(), rows = [], auditRows = [];
    barcodes.forEach(barcode => {
      const student = studentsByBarcode[barcode], key = `${date}|${student.studentId}`, currentlyAbsent = activeKeys.has(key);
      if (currentlyAbsent === absent) return;
      rows.push([Utilities.getUuid(), date, student.studentId, barcode, absent ? 'ABSENT' : 'CANCELLED', now, operator]);
      auditRows.push([now, absent ? 'MARK_ABSENT' : 'CLEAR_ABSENT', '', student.studentId, currentlyAbsent ? 'ABSENT' : '', absent ? 'ABSENT' : 'CANCELLED', operator]);
    });
    if (rows.length) {
      const sheet = getSheet_(SHEETS.ABSENCES);
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.Absences.length).setValues(rows);
      const auditSheet = getSheet_(SHEETS.AUDIT);
      auditSheet.getRange(auditSheet.getLastRow() + 1, 1, auditRows.length, HEADERS.AuditLog.length).setValues(auditRows);
    }
    return { success: true, changed: rows.length, date, absent };
  } finally {
    lock.releaseLock();
  }
}

/** 未提出をまとめて提出済みにする。一度の読込・一度の書込で通信待ちを減らす。 */
function api_setManualSubmissionsBatch(data) {
  assertTeacher_();
  ensureReady_();
  const items = Array.isArray(data && data.items) ? data.items.slice(0, 500) : [];
  if (!items.length) throw new Error('提出済みにする児童を選択してください。');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const assignments = {};
    listAssignments_().forEach(a => assignments[a.assignmentId] = a);
    const students = {};
    listStudents_().filter(s => s.isActive).forEach(s => students[s.barcode] = s);
    ensureAllAssignmentTargets_();
    const targetKeys = new Set(valuesAsObjects_(getSheet_(SHEETS.TARGETS)).map(r => `${r.assignmentId}|${r.studentId}`));
    const submissionSheet = getSheet_(SHEETS.SUBMISSIONS);
    const existingKeys = new Set(valuesAsObjects_(submissionSheet)
      .filter(r => String(r.status) === 'SUBMITTED')
      .map(r => `${r.assignmentId}|${r.studentId}`));
    const uniqueRequestKeys = new Set();
    const newRows = [], auditRows = [], results = [], now = new Date(), operator = currentEmail_();

    items.forEach(item => {
      const assignmentId = String(item.assignmentId || ''), barcode = String(item.barcode || '').trim();
      const assignment = assignments[assignmentId], student = students[barcode];
      const requestKey = `${assignmentId}|${barcode}`;
      if (uniqueRequestKeys.has(requestKey)) return;
      uniqueRequestKeys.add(requestKey);
      if (!assignment || !student) {
        results.push({ assignmentId, barcode, success: false, message: '課題または児童が見つかりません。' });
        return;
      }
      const key = `${assignmentId}|${student.studentId}`;
      if (!targetKeys.has(key)) {
        results.push({ assignmentId, barcode, success: false, message: `${student.name}さんは課題の対象外です。` });
        return;
      }
      if (existingKeys.has(key)) {
        results.push({ assignmentId, barcode, success: true, alreadySubmitted: true });
        return;
      }
      existingKeys.add(key);
      const submissionId = Utilities.getUuid();
      newRows.push([submissionId, assignmentId, student.studentId, barcode, now, 'MANUAL_BATCH', operator, 'SUBMITTED']);
      auditRows.push([now, 'MANUAL_BATCH_SUBMIT', assignmentId, student.studentId, '', 'SUBMITTED', operator]);
      results.push({ assignmentId, barcode, submissionId, success: true, alreadySubmitted: false });
    });

    if (newRows.length) submissionSheet.getRange(submissionSheet.getLastRow() + 1, 1, newRows.length, HEADERS.Submissions.length).setValues(newRows);
    if (auditRows.length) {
      const auditSheet = getSheet_(SHEETS.AUDIT);
      auditSheet.getRange(auditSheet.getLastRow() + 1, 1, auditRows.length, HEADERS.AuditLog.length).setValues(auditRows);
    }
    return { success: true, saved: newRows.length, results, failed: results.filter(r => !r.success).length };
  } finally {
    lock.releaseLock();
  }
}

/** 直前の一括提出変更を、発行した提出ID単位で安全に取り消す。 */
function api_undoManualSubmissionsBatch(data) {
  assertTeacher_();
  ensureReady_();
  const ids = new Set((Array.isArray(data && data.submissionIds) ? data.submissionIds : []).slice(0, 500).map(String));
  if (!ids.size) throw new Error('取り消す一括変更がありません。');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSheet_(SHEETS.SUBMISSIONS), rows = valuesAsObjects_(sheet);
    const statusColumn = HEADERS.Submissions.indexOf('status') + 1;
    const targets = [];
    rows.forEach((r, i) => {
      if (ids.has(String(r.submissionId)) && String(r.status) === 'SUBMITTED' && String(r.method) === 'MANUAL_BATCH') {
        targets.push({ row: i + 2, assignmentId: String(r.assignmentId), studentId: String(r.studentId), barcode: String(r.barcode), submissionId: String(r.submissionId) });
      }
    });
    if (!targets.length) return { success: false, undone: 0, rows: [], message: '取り消せる提出記録がありません。' };
    sheet.getRangeList(targets.map(t => `${columnLetter_(statusColumn)}${t.row}`)).setValue('CANCELLED');
    const now = new Date(), operator = currentEmail_();
    const auditRows = targets.map(t => [now, 'UNDO_MANUAL_BATCH_SUBMIT', t.assignmentId, t.studentId, 'SUBMITTED', 'CANCELLED', operator]);
    const auditSheet = getSheet_(SHEETS.AUDIT);
    auditSheet.getRange(auditSheet.getLastRow() + 1, 1, auditRows.length, HEADERS.AuditLog.length).setValues(auditRows);
    return { success: true, undone: targets.length, rows: targets };
  } finally {
    lock.releaseLock();
  }
}

// 旧画面からの更新にも対応する。
function updateStatus(data) {
  assertTeacher_();
  const assignment = listAssignments_().find(a => a.dateLabel === data.date && a.title === data.task);
  if (assignment) return api_setManualSubmission({ assignmentId: assignment.assignmentId, barcode: data.barcode, submitted: data.status === '〇' });
  return { success: false };
}

function buildDashboard_(assignmentRows, studentRows) {
  const assignments = assignmentRows || listAssignments_();
  const students = (studentRows || listStudents_()).filter(s => s.isActive);
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

function getActiveAbsenceKeys_() {
  const latest = {};
  valuesAsObjects_(getSheet_(SHEETS.ABSENCES)).forEach(row => {
    const date = normalizeDate_(row.date), studentId = String(row.studentId || '');
    if (date && studentId) latest[`${date}|${studentId}`] = String(row.status || '').toUpperCase();
  });
  return new Set(Object.keys(latest).filter(key => latest[key] === 'ABSENT'));
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
  return findStudentAccessByEmail_(email).barcode;
}

function findStudentAccessByEmail_(email) {
  email = normalizeEmail_(email);
  if (!email) return { barcode: '', role: '' };
  let student = listStudents_().find(s => normalizeEmail_(s.studentEmail) === email);
  if (student) return { barcode: student.barcode, role: 'STUDENT', studentId: student.studentId };
  student = listStudents_().find(s => normalizeEmail_(s.parentEmail) === email);
  if (student) return { barcode: student.barcode, role: 'PARENT', studentId: student.studentId };
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEETS.LEGACY_ACCOUNT);
  if (!sheet) return { barcode: '', role: '' };
  const rows = sheet.getDataRange().getValues();
  let row = rows.find(r => normalizeEmail_(r[2]) === email);
  if (row) return { barcode: String(row[0]).trim(), role: 'STUDENT' };
  row = rows.find(r => normalizeEmail_(r[3]) === email);
  return row ? { barcode: String(row[0]).trim(), role: 'PARENT' } : { barcode: '', role: '' };
}

function getDutySession_(dutySessionId) {
  return valuesAsObjects_(getSheet_(SHEETS.DUTY_SESSIONS)).find(r => String(r.dutySessionId) === String(dutySessionId)) || null;
}

function isDutySessionOpen_(session) {
  const now = new Date(), start = new Date(session.startsAt), end = new Date(session.endsAt);
  return String(session.status) === 'OPEN' && !isNaN(start) && !isNaN(end) && start <= now && now <= end;
}

function getActiveDutySessionsFor_(studentId, email) {
  const assignments = {};
  listAssignments_().forEach(a => assignments[a.assignmentId] = a);
  const memberSessionIds = new Set(valuesAsObjects_(getSheet_(SHEETS.DUTY_MEMBERS))
    .filter(r => String(r.studentId) === String(studentId) && normalizeEmail_(r.studentEmail) === normalizeEmail_(email))
    .map(r => String(r.dutySessionId)));
  return valuesAsObjects_(getSheet_(SHEETS.DUTY_SESSIONS))
    .filter(s => memberSessionIds.has(String(s.dutySessionId)) && isDutySessionOpen_(s))
    .map(s => {
      const a = assignments[String(s.assignmentId)] || {};
      return {
        dutySessionId: String(s.dutySessionId), assignmentId: String(s.assignmentId),
        title: String(a.title || ''), subject: String(a.subject || ''), dateLabel: String(a.dateLabel || ''),
        endsAt: new Date(s.endsAt).toISOString()
      };
    });
}

function getDutyAdminData_(assignmentRows, studentRows) {
  const assignments = {}, students = {};
  (assignmentRows || listAssignments_()).forEach(a => assignments[a.assignmentId] = a);
  (studentRows || listStudents_()).forEach(s => students[s.studentId] = s);
  const membersBySession = {};
  valuesAsObjects_(getSheet_(SHEETS.DUTY_MEMBERS)).forEach(r => {
    const id = String(r.dutySessionId);
    if (!membersBySession[id]) membersBySession[id] = [];
    const student = students[String(r.studentId)];
    membersBySession[id].push({ studentId: String(r.studentId), name: student ? student.name : '', email: normalizeEmail_(r.studentEmail) });
  });
  return valuesAsObjects_(getSheet_(SHEETS.DUTY_SESSIONS)).map(s => {
    const a = assignments[String(s.assignmentId)] || {};
    return {
      dutySessionId: String(s.dutySessionId), assignmentId: String(s.assignmentId), title: String(a.title || ''),
      dateLabel: String(a.dateLabel || ''), startsAt: new Date(s.startsAt).toISOString(), endsAt: new Date(s.endsAt).toISOString(),
      status: isDutySessionOpen_(s) ? 'OPEN' : String(s.status) === 'OPEN' ? 'EXPIRED' : String(s.status),
      members: membersBySession[String(s.dutySessionId)] || []
    };
  }).sort((a, b) => b.startsAt.localeCompare(a.startsAt));
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

function ensureReady_() {
  if (!isPhase1Ready_()) throw new Error('先に「初期設定を実行」を押してください。');
  ensureTargetsSheet_();
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  ensureSheet_(ss, SHEETS.DUTY_SESSIONS, HEADERS.DutySessions);
  ensureSheet_(ss, SHEETS.DUTY_MEMBERS, HEADERS.DutyMembers);
  ensureSheet_(ss, SHEETS.SETTINGS, HEADERS.Settings);
  ensureSheet_(ss, SHEETS.ABSENCES, HEADERS.Absences);
}
function getSettings_() {
  const values = Object.assign({}, DEFAULT_SETTINGS);
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID), sheet = ss.getSheetByName(SHEETS.SETTINGS);
  if (sheet) valuesAsObjects_(sheet).forEach(r => { const key = String(r.key || ''); if (key in values) values[key] = String(r.value == null ? '' : r.value); });
  return {
    APP_NAME: values.APP_NAME || DEFAULT_SETTINGS.APP_NAME,
    SCHOOL_NAME: values.SCHOOL_NAME || '',
    DEFAULT_GRADE: Number(values.DEFAULT_GRADE) || 6,
    DEFAULT_CLASS: Number(values.DEFAULT_CLASS) || 3,
    DEFAULT_SUBJECT: values.DEFAULT_SUBJECT || '国語',
    DEFAULT_ASSIGNMENT_STATUS: values.DEFAULT_ASSIGNMENT_STATUS === 'DRAFT' ? 'DRAFT' : 'OPEN',
    DEFAULT_STATUS_PERIOD: ['TODAY', 'WEEK', 'MONTH', 'ALL'].includes(values.DEFAULT_STATUS_PERIOD) ? values.DEFAULT_STATUS_PERIOD : 'MONTH',
    DUTY_DURATION_MINUTES: Math.min(480, Math.max(15, Number(values.DUTY_DURATION_MINUTES) || 120)),
    SCAN_AUTO_SUBMIT: toBool_(values.SCAN_AUTO_SUBMIT),
    SCAN_BATCH_SIZE: Math.min(100, Math.max(1, Number(values.SCAN_BATCH_SIZE) || 50)),
    CAMERA_COOLDOWN_MS: Math.min(10000, Math.max(500, Number(values.CAMERA_COOLDOWN_MS) || 2500)),
    PRINT_TITLE: values.PRINT_TITLE || DEFAULT_SETTINGS.PRINT_TITLE,
    PRINT_DEFAULT_MODE: values.PRINT_DEFAULT_MODE === 'MISSING' ? 'MISSING' : 'ALL',
    PRINT_CONFIRMATION: toBool_(values.PRINT_CONFIRMATION),
    ABSENCE_COUNTS_AS_MISSING: toBool_(values.ABSENCE_COUNTS_AS_MISSING)
  };
}
function isPhase1Ready_() { return !!SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEETS.STUDENTS); }
function getSheet_(name) { const s = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name); if (!s) throw new Error(`${name} シートがありません。`); return s; }
function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1d4ed8').setFontColor('#ffffff');
  }
  return sheet;
}
function valuesAsObjects_(sheet) {
  if (sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues(), headers = values[0].map(String);
  return values.slice(1).filter(r => r.some(v => v !== '')).map(r => headers.reduce((o, h, i) => (o[h] = r[i], o), {}));
}
function deleteDataRowsWhere_(sheetName, predicate) {
  const sheet = getSheet_(sheetName);
  const rows = valuesAsObjects_(sheet);
  let deleted = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (predicate(rows[i])) {
      sheet.deleteRow(i + 2);
      deleted++;
    }
  }
  return deleted;
}
function objectToRow_(obj, headers) { return headers.map(h => obj[h] === undefined ? '' : obj[h]); }
function columnLetter_(column) {
  let n = Number(column), result = '';
  while (n > 0) { n--; result = String.fromCharCode(65 + n % 26) + result; n = Math.floor(n / 26); }
  return result;
}
function normalizeEmail_(value) { return String(value || '').trim().toLowerCase(); }
function currentEmail_() { return normalizeEmail_(Session.getActiveUser().getEmail()); }
function isTeacherAccount_(email) { return TEACHER_EMAILS.map(normalizeEmail_).includes(normalizeEmail_(email)); }
function hashTeacherPassword_(password) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, `HOMEWORK_CHECK_V2|${String(password || '')}`, Utilities.Charset.UTF_8)
    .map(b => (`0${((b + 256) % 256).toString(16)}`).slice(-2)).join('');
}
function getTeacherPasswordHash_() {
  return PropertiesService.getScriptProperties().getProperty(TEACHER_PASSWORD_PROPERTY) || hashTeacherPassword_(DEFAULT_TEACHER_PASSWORD);
}
function isTeacherAuthenticated_() {
  return CacheService.getUserCache().get(TEACHER_AUTH_CACHE_KEY) === getTeacherPasswordHash_();
}
function assertTeacher_() {
  if (!isTeacherAccount_(currentEmail_())) throw new Error('教師用機能を利用する権限がありません。');
  if (!isTeacherAuthenticated_()) throw new Error('教師用パスワードでログインしてください。');
}
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
