"use strict";

const period = document.getElementById("traffic-period");
const sections = document.querySelectorAll("[data-period]");
function showPeriod() {
  for (const section of sections) section.hidden = section.dataset.period !== period.value;
}
period.addEventListener("change", showPeriod);
showPeriod();
