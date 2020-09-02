import { ref, computed, onUnmounted } from '@vue/composition-api'
import { BridgeEvents, parse } from '@vue-devtools/shared-utils'
import cloneDeep from 'lodash/cloneDeep'
import Vue from 'vue'
import { formatTime } from '@front/util/format'
import { useApps, getApps } from '../apps'
import { getBridge } from '../bridge'

const STACK_DURATION = 10

const startTime = ref(0)
const endTime = ref(0)
const minTime = ref(0)
const maxTime = ref(0)

const layersPerApp = ref({})

const selectedEvent = ref(null)

function layerFactory (options) {
  return {
    ...options,
    events: [],
    displayedEvents: [],
    eventTimeMap: {}
  }
}

function builtinLayersFactory () {
  return [
    {
      id: 'mouse',
      label: 'Mouse',
      color: 0xA451AF
    },
    {
      id: 'keyboard',
      label: 'Keyboard',
      color: 0x8151AF
    },
    {
      id: 'component-event',
      label: 'Component events',
      color: 0x41B883
    }
  ].map(options => layerFactory(options))
}

const resetCbs = []

export function resetTimeline () {
  selectedEvent.value = null

  const now = Date.now()
  startTime.value = now - 1000
  endTime.value = now
  minTime.value = now - 1000
  maxTime.value = now
  layersPerApp.value = {}

  fetchLayers()

  for (const cb of resetCbs) {
    cb()
  }
}

export function onTimelineReset (cb) {
  onUnmounted(() => {
    const index = resetCbs.indexOf(cb)
    if (index !== -1) resetCbs.splice(cb)
  })

  resetCbs.push(cb)
}

const addEventCbs = []

export function onEventAdd (cb) {
  onUnmounted(() => {
    const index = addEventCbs.indexOf(cb)
    if (index !== -1) addEventCbs.splice(cb)
  })

  addEventCbs.push(cb)
}

function addEvent (appId, event, layer) {
  event.layer = layer
  event.appId = appId
  layer.events.push(event)
  event.stackedEvents = []
  const wasStacked = stackEvent(event)

  if (!wasStacked) {
    // Update scrollbar
    const scrollTime = event.time + 100
    if (scrollTime > maxTime.value) {
      if (endTime.value === maxTime.value) {
        if (endTime.value - startTime.value > 15000 || startTime.value !== minTime.value) {
          // Autoscroll
          const size = endTime.value - startTime.value
          startTime.value = scrollTime - size
        }
        endTime.value = scrollTime
      }
      maxTime.value = scrollTime
    }
  }

  for (const cb of addEventCbs) {
    cb(event)
  }
}

function stackEvent (event) {
  const roundedTime = Math.round(event.time / STACK_DURATION)
  // Try neighbors too
  const times = [roundedTime, roundedTime - STACK_DURATION, roundedTime + STACK_DURATION]
  let wasStacked = false
  for (const k in times) {
    wasStacked = !!_stackEvent(event, times[k])
    if (wasStacked) break
  }
  if (!wasStacked) {
    event.layer.eventTimeMap[roundedTime] = event
    event.layer.displayedEvents.push(event)
    event.stackedEvents = [event]
  }
  return wasStacked
}

function _stackEvent (event, roundedTime) {
  const existingEvent = event.layer.eventTimeMap[roundedTime]
  if (existingEvent) {
    existingEvent.stackedEvents.push(event)
    event.stackParent = existingEvent
  }
  return existingEvent
}

export function useTime () {
  return {
    startTime,
    endTime,
    minTime,
    maxTime
  }
}

function getLayers (appId) {
  let layers = layersPerApp.value[appId]
  if (!layers) {
    layers = builtinLayersFactory()
    Vue.set(layersPerApp.value, appId, layers)
    // Read the property again to make it reactive
    layers = layersPerApp.value[appId]
  }
  return layers
}

export function useLayers () {
  const { currentAppId } = useApps()

  return {
    layers: computed(() => getLayers(currentAppId.value))
  }
}

export function useSelectedEvent () {
  return {
    selectedEvent,
    selectedStackedEvents: computed(() => selectedEvent.value.stackedEvents.map(e => ({
      data: parse(e.data),
      time: formatTime(e.time, 'ms')
    })))
  }
}

function fetchLayers () {
  getBridge().send(BridgeEvents.TO_BACK_TIMELINE_LAYER_LIST, {})
}

export function setupTimelineBridgeEvents (bridge) {
  bridge.on(BridgeEvents.TO_FRONT_TIMELINE_EVENT, ({ appId, layerId, event }) => {
    const appIds = appId === 'all' ? getApps().map(app => app.id) : [appId]
    for (const appId of appIds) {
      const layer = getLayers(appId).find(l => l.id === layerId)
      if (!layer) {
        console.error(`Layer ${layerId} not found`)
        return
      }

      addEvent(appId, cloneDeep(event), layer)
    }
  })

  bridge.on(BridgeEvents.TO_FRONT_TIMELINE_LAYER_ADD, () => {
    fetchLayers()
  })

  bridge.on(BridgeEvents.TO_FRONT_TIMELINE_LAYER_LIST, ({ layers }) => {
    for (const layer of layers) {
      const existingLayers = getLayers(layer.appId)
      if (!existingLayers.some(l => l.id === layer.id)) {
        existingLayers.push(layerFactory(layer))
      }
    }
  })

  resetTimeline()
}