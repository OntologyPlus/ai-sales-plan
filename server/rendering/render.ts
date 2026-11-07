import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  convertMillimetersToTwip,
} from "docx";

type Citation = { versionId: string; start: number; quote: string };
const mm = convertMillimetersToTwip;

// Build the document in memory; no external programs or temporary files needed.
export async function renderApproval(payload: any): Promise<{ docx: Buffer }> {
  const snap = payload.snapshot,
    body = snap.body,
    children: (Paragraph | Table)[] = [];
  const font = process.env.DOCUMENT_FONT || "Microsoft YaHei";
  const paragraph = (
    value: unknown,
    options: {
      center?: boolean;
      heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel];
      size?: number;
    } = {},
  ) =>
    new Paragraph({
      heading: options.heading,
      alignment: options.center ? AlignmentType.CENTER : undefined,
      spacing: { after: 140, line: 348 },
      children: [
        new TextRun({
          text: String(value ?? ""),
          ...(options.size ? { size: options.size } : {}),
        }),
      ],
    });
  const text = (value: unknown) => children.push(paragraph(value));
  const heading = (value: string, level: 1 | 2 = 1) =>
    children.push(
      paragraph(value, {
        heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
      }),
    );
  const table = (headers: string[], records: unknown[][], widths: number[]) => {
    const border = { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" };
    children.push(
      new Table({
        alignment: AlignmentType.CENTER,
        width: { size: mm(166), type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        columnWidths: widths.map(mm),
        borders: {
          top: border, bottom: border, left: border, right: border,
          insideHorizontal: border, insideVertical: border,
        },
        rows: [headers, ...records].map(
          (record, index) =>
            new TableRow({
              tableHeader: index === 0,
              cantSplit: true,
              children: record.map(
                (value, i) =>
                  new TableCell({
                    width: { size: mm(widths[i]), type: WidthType.DXA },
                    verticalAlign: VerticalAlign.CENTER,
                    margins: { top: 100, bottom: 100, left: 100, right: 100 },
                    ...(index === 0 ? { shading: { fill: "E8EEF2" } } : {}),
                    children: String(value ?? "未知").split(/\r?\n/).map(
                      (line) => new Paragraph({
                        spacing: { after: 80, line: 288 },
                        children: [new TextRun({ text: line, size: 20, bold: index === 0 })],
                      }),
                    ),
                  }),
              ),
            }),
        ),
      }),
      new Paragraph({ spacing: { after: 80 } }),
    );
  };

  children.push(paragraph(snap.title, { heading: HeadingLevel.TITLE, center: true }));
  children.push(paragraph("应用方案", { center: true }));
  children.push(paragraph(`V${snap.edition}  修订${snap.revision}  已批准`, { center: true }));
  text("本方案说明客户需求、产品匹配依据、应用条件及风险边界。具体产品适用性以已批准正文、引用资料与专业审核意见共同确定。");
  table(["项目", "内容"], [
    ["客户", snap.customer?.name ?? "未记录"],
    ["应用场景", snap.scene], ["方案编号", snap.code],
    ["审批编号", payload.requestId], ["批准日期", payload.approvedOn ?? ""],
  ], [30, 136]);
  const visible = (s: any) => s.enabled !== false && (s.required !== false || s.content?.trim());
  heading("内容导航");
  body.sections.forEach((s: any, i: number) => {
    if (visible(s)) children.push(paragraph(`${i + 1}  ${s.title}`, { size: 20 }));
  });
  text("附录  原文引用与审批记录");
  children.push(new Paragraph({ pageBreakBefore: true }));
  heading("客户需求与产品匹配");
  for (const line of String(body.requirements ?? "").split(/\r?\n/)) text(line);
  const products = snap.matchingSnapshot?.products ?? [];
  const labels: Record<string, string> = {
    match: "满足已知阈值", mismatch: "不满足", unknown: "无法判定", validation: "待验证",
  };
  for (const product of products) {
    heading(`${product.code}  ${product.name}`, 2);
    text(`参数版本 ${product.specVersion ?? "未知"}`);
    table(["需求", "客户阈值", "产品范围", "判断及原因"], product.results.map((r: any) => [
      r.label, r.requirement, r.actual, `${labels[r.status] ?? r.status}\n${r.reason}`,
    ]), [31, 39, 39, 57]);
  }
  if (!products.length) text("本版本未登记结构化产品匹配，产品推荐依据见正式章节。");
  if(snap.projectSnapshot){
    const project=snap.projectSnapshot;
    if(project.conclusions?.length){heading("已确认验证结论与适用范围");for(const c of project.conclusions){heading(c.label,2);text(c.scope);text(c.interpretation);text(`样品/批次：${c.sampleBatch}；方法：${c.method}；条件：${c.conditions}`);text(`结论对象 ${c.id} / 修订${c.revision}`);if(c.analysis)table(["指标","原始值/单位","约定判据","结果"],c.analysis.results.map((r:any)=>[r.label,`${r.actual??"缺测"} ${r.unit}`,`${({gte:"≥",lte:"≤",eq:"="} as any)[r.operator]} ${r.target}`,({pass:"通过",fail:"不通过",unknown:"无法判断"} as any)[r.status]]),[42,42,42,40]);}}
    heading("客户价值与获批商务条件");
    text(`有效期至 ${project.validUntil}`);
    text(project.publicTerms);
    if(project.quote)table(["币种","数量","净单价","折让","净收入"],[[project.currency,project.quote.quantity,project.quote.netUnitPrice,project.quote.discount,project.quote.netRevenue]],[25,30,37,37,37]);
    for(const value of project.values||[]){heading(value.label,2);text(value.basis||"");text(value.period||"");text(value.assumptions||"");const c=value.calculation;text(c.claim);table(["基线成本","候选成本","条件差额","币种"],[[c.baseline??"未知",c.candidate??"未知",c.difference??"未知",c.currency]],[43,43,43,37]);}
  }
  const references: Citation[] = [], referenceIds = new Map<string, number>();
  const reference = (citation: Citation) => {
    const key = JSON.stringify([citation.versionId, citation.start, citation.quote]);
    let id = referenceIds.get(key);
    if (id === undefined) {
      references.push(citation);
      id = references.length;
      referenceIds.set(key, id);
    }
    return id;
  };
  body.sections.forEach((s: any, i: number) => {
    if (!visible(s)) return;
    heading(`${i + 1}  ${s.title}`);
    for (const line of s.content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/^#{2,3} /.test(line)) heading(line.replace(/^#{2,3} /, ""), 2);
      else text(line);
    }
    if (s.evidence) text(`适用条件与待补证说明  ${s.evidence}`);
    const refs = (s.citations ?? []).map(reference);
    if (refs.length) text(`本章原文引用  ${refs.join(", ")}`);
  });
  for (const product of products)
    for (const attr of product.parameters ?? []) reference(attr.citation);
  for (const citation of body.confirmedRequirements ?? []) reference(citation);
  for (const risk of snap.riskSnapshot ?? []) {
    const citations = typeof risk.evidence === "string" ? JSON.parse(risk.evidence) : risk.evidence ?? [];
    for (const citation of citations) reference(citation);
  }
  if (snap.riskSnapshot?.length) {
    heading("风险处理记录");
    const statuses: Record<string, string> = { open: "待补证", submitted: "待独立复核", closed: "已关闭" };
    for (const risk of snap.riskSnapshot) {
      heading(risk.title, 2);
      text(`责任人 ${risk.owner_name ?? "未记录"}  状态 ${statuses[risk.status] ?? risk.status}`);
      text(risk.note ?? "");
    }
  }
  heading("附录  原文引用与审批记录");
  const versions = new Map<string, any>((snap.evidenceVersions ?? []).map((v: any) => [v.id, v]));
  references.forEach((citation, i) => {
    const version = versions.get(citation.versionId);
    heading(`引用 ${i + 1}  ${version?.title ?? "资料原文"}  V${version?.version ?? "未知"}`, 2);
    for (const line of citation.quote.split(/\r?\n/)) text(line);
    text(`提取文本字符位置 ${citation.start}  来源版本 ${citation.versionId}`);
    if (version?.sha256) text(`原件指纹 ${version.sha256}`);
  });
  const roles: Record<string, string> = { chemist: "应用化学师", compliance: "合规专员", leader: "审批领导",finance:"独立财务复核",quality:"供应与质量",legal:"法务审核" };
  heading("审批记录", 2);
  table(["审核环节", "审核人", "时间及意见"], payload.steps.map((s: any) => [
    roles[s.role] ?? s.role, s.name, `${s.decidedAt}\n${s.comment || "通过"}`,
  ]), [35, 30, 101]);
  text(`批准快照指纹 ${payload.snapshotHash}`);

  const document = new Document({
    title: snap.title,
    creator: "",
    lastModifiedBy: "",
    styles: {
      default: {
        document: { run: { font: { ascii: font, hAnsi: font, eastAsia: font, cs: font }, size: 22, color: "000000" } },
        title: { run: { size: 52, bold: true }, paragraph: { keepNext: true, spacing: { before: 600, after: 320 } } },
        heading1: { run: { size: 34, bold: true, color: "000000" }, paragraph: { keepNext: true } },
        heading2: { run: { size: 26, bold: true, color: "000000" }, paragraph: { keepNext: true } },
      },
    },
    sections: [{
      properties: {
        page: { size: { width: mm(210), height: mm(297) }, margin: { top: mm(22), bottom: mm(22), left: mm(22), right: mm(22) } },
      },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "第 ", size: 18 }), new TextRun({ children: [PageNumber.CURRENT], size: 18 }), new TextRun({ text: " 页", size: 18 })],
      })] }) },
      children,
    }],
  });
  return { docx: await Packer.toBuffer(document) };
}
