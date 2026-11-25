/**
 * HTML mail bodies the way common senders write them, for tests that pin the
 * text the HTML-to-text helpers read out of a mail. Names, numbers and
 * domains are made up.
 */

/** An invoice mail from Outlook: Word's head with a commented style block and conditional comments. */
export const OUTLOOK_INVOICE_MAIL = `<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns:m="http://schemas.microsoft.com/office/2004/12/omml" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="Generator" content="Microsoft Word 15 (filtered medium)">
<style><!--
/* Font Definitions */
@font-face
	{font-family:"Cambria Math";
	panose-1:2 4 5 3 5 4 6 3 2 4;}
/* Style Definitions */
p.MsoNormal, li.MsoNormal, div.MsoNormal
	{margin:0cm;
	font-size:11.0pt;
	font-family:"Calibri",sans-serif;}
--></style><!--[if gte mso 9]><xml>
<o:shapedefaults v:ext="edit" spidmax="1026" />
</xml><![endif]--><!--[if gte mso 9]><xml>
<o:shapelayout v:ext="edit">
<o:idmap v:ext="edit" data="1" />
</o:shapelayout></xml><![endif]-->
</head>
<body lang="SV" link="#0563C1" vlink="#954F72" style="word-wrap:break-word">
<div class="WordSection1">
<p class="MsoNormal">Hej,<o:p></o:p></p>
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>
<p class="MsoNormal">Bifogat finns faktura 2025-0042 f&ouml;r november.<o:p></o:p></p>
<p class="MsoNormal">Att betala: 12&nbsp;500,00 kr inkl. moms. F&ouml;rfallodag 2025-12-31.<o:p></o:p></p>
<p class="MsoNormal">Bankgiro 123-4567, OCR 20250042.<o:p></o:p></p>
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>
<p class="MsoNormal">Med v&auml;nliga h&auml;lsningar<br>
Anna Exempel<br>
Exempel Leverant&ouml;r AB<o:p></o:p></p>
</div>
</body>
</html>
`

/** A web shop's receipt: an XHTML table layout with a title, a style block and a tracking pixel. */
export const SHOP_RECEIPT_MAIL = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Ditt kvitto fr&aring;n Exempelbutiken</title>
<style type="text/css">
body { margin: 0; padding: 0; }
@media only screen and (max-width: 600px) { .container { width: 100% !important; } }
</style>
</head>
<body style="margin:0;padding:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center">
<table class="container" width="600" cellpadding="0" cellspacing="0">
<tr><td><h1 style="font-size:20px">Tack f&ouml;r ditt k&ouml;p!</h1></td></tr>
<tr><td>Ordernummer: <strong>100-2381</strong></td></tr>
<tr><td>Kontorsstol Ergo &amp; fotst&ouml;d</td><td align="right">2&#160;990,00&nbsp;kr</td></tr>
<tr><td>Frakt</td><td align="right">49,00&nbsp;kr</td></tr>
<tr><td><b>Totalt</b></td><td align="right"><b>3&#160;039,00&nbsp;kr</b></td></tr>
<tr><td>Varav moms 25&nbsp;%: 607,80&nbsp;kr</td></tr>
</table>
<img src="https://shop.example/open.gif?id=abc" width="1" height="1" alt="" />
</td></tr>
</table>
</body>
</html>
`

/** A receipt forwarded from Gmail, with the forwarding header Gmail writes above it. */
export const GMAIL_FORWARDED_RECEIPT = `<div dir="ltr"><br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>Från: <strong class="gmail_sendername" dir="auto">Exempel Hosting</strong> <span dir="auto">&lt;faktura@hosting.example&gt;</span><br>Date: tis 25 nov. 2025 kl 09:14<br>Subject: Kvitto för betalning #48213<br>To: &lt;ekonomi@foretaget.example&gt;<br></div><br><br><div><p>Hej!</p><p>Vi har tagit emot din betalning på <b>1&nbsp;249,00 kr</b> för perioden 2025-11-01 till 2025-11-30.</p><ul><li>Webbhotell Bas: 999,00 kr</li><li>Domän foretaget.example: 250,00 kr</li></ul><p>Kortet slutar på 4242.</p><p style="color:#888">Detta mejl kan inte besvaras.</p></div></div></div>
`

/** A page saved from a supplier portal: upper-case tags, a script, end tags with odd spacing and an unclosed comment at the end. */
export const PORTAL_INVOICE_PAGE = `<HTML><HEAD><TITLE>Faktura 7781</TITLE>
<SCRIPT type="text/javascript">window.dataLayer = window.dataLayer || []; if (a < b && c > d) { track('view') }</SCRIPT >
<style media="print">.no-print{display:none}</style
>
</HEAD>
<BODY>
<!-- header start --><DIV class=hdr>Exempel Leverant&ouml;r AB</DIV><!-- header end --!>
<H2>Faktura 7781</H2>
<P>Fakturadatum: 2025-11-03<BR/>Förfallodag: 2025-12-03</P>
<TABLE><TR><TD>Konsulttimmar, 10 h</TD><TD>9&#x00A0;500,00</TD></TR><TR><TD>Moms 25 %</TD><TD>2&nbsp;375,00</TD></TR></TABLE>
<P>Summa att betala: <B>11&nbsp;875,00 SEK</B></P>
<HR>
<p>Bet.villkor 30 dagar netto. Dr&ouml;jsm&aring;lsr&auml;nta enligt r&auml;ntelagen.</p>
<noscript><img src="https://portal.example/px.gif"></noscript>
</BODY></HTML>
<!-- generated 2025-11-03T08:00:00Z
`

/** Every fixture, by name, for tests that run the same check over all of them. */
export const MAIL_HTML_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ['an Outlook invoice mail', OUTLOOK_INVOICE_MAIL],
  ['a web shop receipt', SHOP_RECEIPT_MAIL],
  ['a receipt forwarded from Gmail', GMAIL_FORWARDED_RECEIPT],
  ['a page saved from a supplier portal', PORTAL_INVOICE_PAGE],
]
