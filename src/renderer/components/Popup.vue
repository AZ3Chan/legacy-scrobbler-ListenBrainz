<template>
  <div class="popup-container">
    <div class="popup">
      <img src="../assets/ls-logo.png" alt="" />
      <div class="content">
        <h1>{{ popup.content.title }}</h1>
        <div class="credits-container" v-html="popup.content.message"></div>
        <input
          v-if="popup.content.button === 'Login'"
          v-model="tokenInput"
          type="password"
          class="token-input"
          placeholder="Paste your User Token here"
          @keyup.enter="popUpAction"
        />
      </div>

      <button @click="popUpAction">{{ popup.content.button }}</button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useStates } from '../composables/useStates.js'
const { popup } = useStates()

import { usePrefs } from '../composables/usePrefs.js'
const { setPreferences } = usePrefs()

const emit = defineEmits(['handleConnect', 'handleLogin'])

const tokenInput = ref('')

async function popUpAction () {
  if (popup.content.button === 'Connect') {
    emit('handleConnect')
  } else if (popup.content.button === 'Login') {
    if (tokenInput.value.trim()) {
      await setPreferences('singleConfig', 'listenBrainz', {
        token: tokenInput.value.trim()
      })
    }
    emit('handleLogin')
  } else {
    popup.state = false
  }
}
</script>

<style scoped>
.popup {
  box-sizing: border-box;
  width: 400px;
  min-height: 340px;
  border-radius: 15px;
  background-color: var(--popup-bg);
  box-shadow: 0 1px 1px rgba(0, 0, 0, 0.11), 0 1px 2px rgba(0, 0, 0, 0.11),
    0 2px 4px rgba(0, 0, 0, 0.11), 0 4px 8px rgba(0, 0, 0, 0.11),
    0 8px 16px rgba(0, 0, 0, 0.11), 0 16px 32px rgba(0, 0, 0, 0.11),
    0 0 64px rgba(0, 0, 0, 0.08), 0 0 128px rgba(0, 0, 0, 0.08);
  opacity: 1;
  border: var(--border-color-strong) 0.01px solid;
  padding: 25px 25px 25px 25px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  text-align: center;
  backdrop-filter: blur(18px);
}

.popup p {
  overflow: scroll;
}

.credits-container {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.popup img {
  width: 80px;
  filter: drop-shadow(2px 2px 2px rgb(0, 0, 0, 0.11));
}

.popup h1 {
  padding: 15px 0 4px 0;
}

.token-input {
  all: unset;
  box-sizing: border-box;
  width: 100%;
  margin-top: 14px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color-strong);
  background-color: var(--bg-secondary);
  color: var(--text-primary);
  font-family: 'Barlow-Regular', sans-serif;
  font-size: 13px;
  text-align: left;
  min-height: unset;
  cursor: text;
}

.token-input::placeholder {
  color: var(--text-muted);
}

.token-input:focus {
  outline: 2px solid rgba(1, 125, 199, 0.5);
  outline-offset: 1px;
}
</style>
