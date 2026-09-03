<script lang="ts">
  export let size: 'x-small' | 'small' | 'medium' | 'large' = 'small'
  export let fill: string = 'currentColor'
</script>

<svg class="svg-{size}" {fill} viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <path d="M8 1.5a2 2 0 0 0-2 2v4a2 2 0 1 0 4 0v-4a2 2 0 0 0-2-2Zm-1 2a1 1 0 1 1 2 0v4a1 1 0 1 1-2 0v-4Z" />
  <path
    d="M4 7a.5.5 0 0 0-1 0 5 5 0 0 0 4.5 4.975V13.5H6a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H8.5v-1.525A5 5 0 0 0 13 7a.5.5 0 0 0-1 0 4 4 0 0 1-8 0Z"
  />
</svg>
