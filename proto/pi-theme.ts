// pi's theme must be initialised before any pi component renders. Importing
// this module does that once; the theme instance itself is not exported by pi,
// so only the markdown/select-list getters are available.
import { getMarkdownTheme, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";

initTheme();

export const mdTheme = getMarkdownTheme();
export const selectListTheme = getSelectListTheme();
