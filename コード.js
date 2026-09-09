const SPREADSHEET_ID = '1dDpuYzT9wRAegTDS6JZDqtmBgurI-qWojVrlAnU8S20';
const SHEET_STATUS = '提出状況';
const SHEET_ACCOUNT = 'アカウント';
const TEACHER_EMAILS = ['h953420@g.himeji-hyg.ed.jp']; // 教師メールリスト

function doGet() {
  const email = Session.getActiveUser().getEmail();
  const isTeacher = TEACHER_EMAILS.includes(email);

  const template = HtmlService.createTemplateFromFile(
    isTeacher ? 'Index_Teacher' : 'Index_Student'
  );

  // 保護者・生徒用は自分の子・本人のバーコードを取得
  let childBarcode = '';
  if (!isTeacher) {
    const accountsSheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_ACCOUNT);
    const accounts = accountsSheet.getDataRange().getValues();
    const row = accounts.find(r => r[2] === email || r[3] === email); // 児童メール or 保護者メール
    childBarcode = row ? row[0] : '';
  }

  const statusSheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_STATUS);
  let statusData = statusSheet.getDataRange().getValues();
  if (isTeacher) {
    // ヘッダー行を除外
    statusData = statusData.slice(0);
  }

  template.isTeacher = isTeacher;
  template.childBarcode = childBarcode;
  template.dataJSON = JSON.stringify(statusData);

  return template.evaluate().setTitle('提出状況確認アプリ').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// 更新処理（教師のみ）
function updateStatus(data) {
  const email = Session.getActiveUser().getEmail();
  if (!TEACHER_EMAILS.includes(email)) return { success: false };

  const { barcode, date, task, status } = data;
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_STATUS);
  const values = sheet.getDataRange().getValues();

  let success = false;
  for (let i = 1; i < values.length; i++) { // 1行目はヘッダーなので無視
    const row = values[i];
    const d = new Date(row[0]);
    const formatted = !isNaN(d) ? `${d.getMonth()+1}月${d.getDate()}日` : row[0];
    if (String(row[3]) === String(barcode) && formatted === date && row[5] === task) {
      sheet.getRange(i+1, 7).setValue(status);
      success = true;
      break;
    }
  }

  return { success };
}
