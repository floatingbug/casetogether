<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    id: string;
    label: string;
    modelValue: string;
    type?: 'email' | 'password' | 'text' | undefined;
    autocomplete: string;
    error?: string | undefined;
    hint?: string | undefined;
    inputmode?: 'email' | 'text' | undefined;
    maxlength: number;
  }>(),
  {
    type: 'text',
    error: undefined,
    hint: undefined,
    inputmode: undefined,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const describedBy = computed(() => {
  const ids = [];
  if (props.hint !== undefined) {
    ids.push(`${props.id}-hint`);
  }
  if (props.error !== undefined) {
    ids.push(`${props.id}-error`);
  }
  return ids.length > 0 ? ids.join(' ') : undefined;
});

function updateValue(event: Event): void {
  if (event.target instanceof HTMLInputElement) {
    emit('update:modelValue', event.target.value);
  }
}
</script>

<template>
  <div class="form-field">
    <label :for="id">{{ label }}</label>
    <input
      :id="id"
      :name="id"
      :type="type"
      :value="modelValue"
      :autocomplete="autocomplete"
      :inputmode="inputmode"
      :maxlength="maxlength"
      :aria-invalid="error === undefined ? 'false' : 'true'"
      :aria-describedby="describedBy"
      required
      @input="updateValue"
    />
    <p v-if="hint !== undefined" :id="`${id}-hint`" class="field-hint">{{ hint }}</p>
    <p v-if="error !== undefined" :id="`${id}-error`" class="field-error">{{ error }}</p>
  </div>
</template>
