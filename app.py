import streamlit as st
import streamlit.components.v1 as components

st.set_page_config(page_title="Crash Guard", layout="wide")

# Load CSS
def load_css(file_name):
    with open(file_name, "r", encoding="utf-8") as f:
        st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

# Load JS
def load_js(file_name):
    with open(file_name, "r", encoding="utf-8") as f:
        st.markdown(f"<script>{f.read()}</script>", unsafe_allow_html=True)

# Load HTML into iframe
def load_html(file_name):
    with open(file_name, "r", encoding="utf-8") as f:
        html_code = f.read()
    components.html(html_code, height=4000, scrolling=True)

# Inject files
load_css("styles.css")
load_js("script.js")
load_html("index.html")
