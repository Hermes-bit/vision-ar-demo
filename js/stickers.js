// Stickers Vision AR : purement décoratifs (le texte voisin dit déjà la même chose), donc masqués aux lecteurs d'écran.
const SRC = name => `img/stickers/${name}.webp`;

// Sticker posé dans la page. cls : position (voir .stk-* dans app.css)
export const sticker = (name, cls = "") =>
  `<img class="stk ${cls}" src="${SRC(name)}" alt="" aria-hidden="true" width="384" height="384" decoding="async" draggable="false">`;

// Sticker qui « saute » au milieu de l'écran un instant, pour fêter un moment (départ, arrivée, signalement)
let popTimer = 0;
export function stickerPop(name, ms = 1800) {
  let el = document.getElementById("stkPop");
  if (!el) {
    el = document.createElement("div");
    el.id = "stkPop"; el.className = "stk-pop"; el.setAttribute("aria-hidden", "true");
    document.body.append(el);
  }
  el.innerHTML = `<img src="${SRC(name)}" alt="" draggable="false">`;
  el.classList.remove("out"); el.hidden = false;
  void el.offsetWidth;                                   // relance l'animation d'entrée
  el.classList.add("in");
  clearTimeout(popTimer);
  popTimer = setTimeout(() => {
    el.classList.replace("in", "out");
    popTimer = setTimeout(() => { el.hidden = true; el.classList.remove("out"); }, 350);
  }, ms);
}
