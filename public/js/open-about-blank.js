if (window.frameElement?.hasAttribute("data-page-only")) {
  document.documentElement.classList.add("page-only");
}

function openAboutBlank(url, title) {
  var tab = window.open("about:blank", "_blank");
  if (!tab) {
    alert("Allow pop-ups for Aetheris and try again.");
    return;
  }

  tab.opener = null;
  var doc = tab.document;
  doc.title = title;
  doc.body.style.cssText = "margin:0;overflow:hidden;background:#000";

  var frame = doc.createElement("iframe");
  frame.setAttribute("data-page-only", "");
  frame.title = title;
  frame.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
  frame.allowFullscreen = true;
  frame.referrerPolicy = "no-referrer";
  frame.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;border:0";
  frame.src = url;
  doc.body.appendChild(frame);
}
