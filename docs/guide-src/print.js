const { chromium } = require('/opt/node22/lib/node_modules/playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('file://' + __dirname + '/guide.html', { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await p.pdf({
    path: process.argv[2], format: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;font-size:8px;color:#66708a;font-family:sans-serif;padding:0 18mm;display:flex;justify-content:space-between"><span>RescueRoute · Beginner\'s guide to the DSA</span><span class="pageNumber"></span></div>',
  });
  await b.close();
})();
