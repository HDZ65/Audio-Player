
// Données
const musicsData = [
  { title: "le monde", artist: "HDZ", id: 1 },
  { title: "calle", artist: "HDZ", id: 2 },
  { title: "diamant", artist: "HDZ", id: 3 },
  { title: "souffle", artist: "HDZ", id: 4 },
  { title: "oasis", artist: "HDZ", id: 5 },
  { title: "drill8", artist: "HDZ", id: 6 },
  { title: "frut", artist: "HDZ", id: 7 },
  { title: "boom", artist: "HDZ", id: 8 },
];

const imgData = [
  { title: "le monde", artist: "Betical", id: 1, },
  { title: "Lost-Colours", artist: "TEEMID", id: 2 },
  { title: "Lost-Colours", artist: "SLUMB", id: 3 },
  { title: "souffle", artist: "Fakear", id: 4 },
  { title: "Lost-Colours", artist: "Fakear", id: 5 },
  { title: "drill8", artist: "Fakear", id: 6 },
  { title: "Lost-Colours", artist: "Fakear", id: 7 },
  { title: "boom", artist: "Fakear", id: 8 },
];

// Éléments du DOM
const elements = {
  image: document.querySelector("#img_title"),
  artist: document.querySelector(".artist"),
  title: document.querySelector(".title"),
  list: document.querySelector(".nbr_list"),
  cursor: document.querySelector("#cursor"),
  lecteur: document.querySelector(".lecteur"),
  time: document.querySelector(".time"),
  timeMax: document.querySelector(".timeMax"),
  shuffle: document.querySelector("#shuffle"),
  prev_btn: document.querySelector("#prev_btn"),
  play: document.querySelector("#play"),
  next_btn: document.querySelector("#next_btn"),
  list_music: document.querySelector("#list_music"),
  img_title: document.querySelector("#img_title"),
  img_play: document.querySelector("#btn_play"),
  img_pause: document.querySelector("#pause"),
  img_shuffle: document.querySelector("#img_shuffle"),
  img_shuffleOne: document.querySelector("#img_shuffleOne"),
};
elements.progressBar = document.querySelector("#cursor");

// Variables d'état
let currentMusicIndex = 0;
let savedTime = 0;
let playing = false;
let shuffleBool = false;

// Élément audio
const audioElement = new Audio();

// Fonctions d'aide
function convertTime(duration) {
  let minutes = Math.floor(duration / 60);
  let seconds = Math.floor(duration - minutes * 60);
  let minuteValue = minutes < 10 ? '0' + minutes : minutes;
  let secondValue = seconds < 10 ? '0' + seconds : seconds;
  return minuteValue + ':' + secondValue;
}

function updateMaxTime() {
  elements.timeMax.textContent = convertTime(audioElement.duration);
}

function togglePlay(play, pause) {
  play.classList.toggle("invisible");
  pause.classList.toggle("visible");
}

// Gestionnaires d'événements
audioElement.addEventListener('canplaythrough', updateMaxTime);

audioElement.addEventListener('timeupdate', () => {
  elements.time.textContent = convertTime(audioElement.currentTime);
  savedTime = audioElement.currentTime;
});

audioElement.addEventListener('ended', () => {
  current(true);
});

elements.play.addEventListener('click', () => {
  if (!playing) {
    playMusic(currentMusicIndex);
    togglePlay(elements.img_play, elements.img_pause)
  } else {
    audioElement.pause();
    playing = false;
    togglePlay(elements.img_play, elements.img_pause)
  }
})

elements.next_btn.addEventListener('click', () => {
  if (!playing) {
    togglePlay(elements.img_play, elements.img_pause)
  }
  current(true)
})

elements.prev_btn.addEventListener('click', () => {
  if (!playing) {
    togglePlay(elements.img_play, elements.img_pause)
  }
  current(false)
})

elements.shuffle.addEventListener('click', () => {
  shuffleBool = !shuffleBool
  togglePlay(elements.img_shuffle, elements.img_shuffleOne)
})

audioElement.addEventListener('timeupdate', updateProgressBar);
// Fonctions principales
function updateProgressBar() {
  const progress = (audioElement.currentTime / audioElement.duration) * 100;
  elements.progressBar.style.width = `${progress}%`;
}

function playMusic(index) {
  const img = imgData[index];
  const music = musicsData[index];

  elements.img_title.onerror = function() {
    elements.img_title.src = `./ressources/thumbs/${img.title}.jpg`;
  };
  elements.img_title.src = `./ressources/thumbs/${img.title}.png`;

  const newSrc = `./ressources/music/${music.title}.mp3`;

  if (audioElement.src !== newSrc) {
    audioElement.src = newSrc;
  }

  if (audioElement.paused) {
    audioElement.currentTime = savedTime;
    audioElement.play();
  }

  elements.title.textContent = music.title;
  elements.artist.textContent = music.artist;
  elements.list.textContent = music.id + `/` + musicsData.length;
  playing = true;
}

function current(add) {
  if (add && !shuffleBool) {
    currentMusicIndex = (currentMusicIndex + 1) % musicsData.length;
  } else if (!add && !shuffleBool) {
    if (savedTime > 3) {
      savedTime = 0;
      playMusic(currentMusicIndex);
      return;
    }
    currentMusicIndex = currentMusicIndex > 0 ? currentMusicIndex - 1 : musicsData.length - 1;
  } else if (shuffleBool) {
    let newIndex;
    do {
      newIndex = Math.floor(Math.random() * musicsData.length);
    } while (newIndex === currentMusicIndex);
    currentMusicIndex = newIndex;
  }
  savedTime = 0;
  playMusic(currentMusicIndex);
}

elements.lecteur.addEventListener('click', (e) => {
  const clickPosition = e.offsetX;
  const totalWidth = elements.lecteur.offsetWidth;
  const clickPositionRatio = clickPosition / totalWidth;
  const newTime = clickPositionRatio * audioElement.duration;

  audioElement.currentTime = newTime;
});