import { loadCRM, saveCRM, updateStatuses, generateDailyReport } from "./subs-crm.js";

const crm = loadCRM();
updateStatuses(crm);
const report = generateDailyReport(crm);
saveCRM(crm);
console.log(report.report_text);
