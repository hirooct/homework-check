function importCSVFromDrive() {
  const folderId = "1NG39yVF3kUssFOzyx7ufUYA07NHc9EBZ";
  const fileName = "DATA.csv";
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("提出状況");
  
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFilesByName(fileName);
  
  if (!files.hasNext()) return;
  
  const file = files.next();
  const csv = Utilities.parseCsv(file.getBlob().getDataAsString("UTF-8"));
  
  // シートをA1から置換
  sheet.clearContents();
  sheet.getRange(1, 1, csv.length, csv[0].length).setValues(csv);
}
