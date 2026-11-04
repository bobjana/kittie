function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface EmailLayoutInput {
  title: string;
  preview: string;
  bodyHtml: string;
}

export function emailLayout(input: EmailLayoutInput): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f7f3ff;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;">
  <div aria-hidden="true" style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preview)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f3ff;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border:1px solid #e7e0f5;border-radius:24px;">
          <tr>
            <td style="padding:32px 28px;">
              <p style="margin:0 0 20px;font-size:20px;font-weight:800;color:#241f35;">Kittie</p>
              <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#241f35;">${escapeHtml(input.title)}</h1>
              ${input.bodyHtml}
            </td>
          </tr>
        </table>
        <p style="margin:20px 0 0;font-size:13px;color:#6d6585;">Split expenses with friends, exactly to the cent.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
