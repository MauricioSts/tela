// Captura de áudio POR PROCESSO no Windows (process loopback).
//
// É a peça que o navegador não tem: o WASAPI deixa ativar um IAudioClient
// especial que grava só o que um processo (e seus filhos) toca — ou tudo MENOS
// esse processo. É assim que o Discord transmite sem vazar a própria call, e é
// o que faz a MIMO transmitir a tela inteira sem levar o Discord junto.
//
// Precisa de Windows 10 build 20348+. A ativação é assíncrona e tem que rodar
// em thread MTA, então tudo acontece numa thread própria: ativa, espera o
// handler, configura o formato, e fica no laço de GetBuffer/ReleaseBuffer
// mandando PCM pro JS por uma ThreadSafeFunction.

#include <napi.h>

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <wrl/implements.h>

#include <atomic>
#include <memory>
#include <string>
#include <thread>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;

namespace {

constexpr int kTaxa = 48000;   // 48 kHz estéreo 16 bits: o formato que o resto
constexpr int kCanais = 2;     // do pipeline (Opus/WebRTC) já usa
constexpr int kBits = 16;

std::string HrTexto(const char* onde, HRESULT hr) {
  char buf[128];
  snprintf(buf, sizeof(buf), "%s falhou (0x%08lX)", onde, static_cast<unsigned long>(hr));
  return std::string(buf);
}

// O ActivateAudioInterfaceAsync responde por callback; este handler só guarda o
// resultado e acorda a thread de captura.
class Handler : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase,
                                    IActivateAudioInterfaceCompletionHandler> {
 public:
  Handler() : pronto_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT hrAtivacao = S_OK;
    ComPtr<IUnknown> punk;
    hr_ = op->GetActivateResult(&hrAtivacao, &punk);
    if (SUCCEEDED(hr_)) hr_ = hrAtivacao;
    if (SUCCEEDED(hr_) && punk) hr_ = punk.As(&cliente_);
    SetEvent(pronto_);
    return S_OK;
  }

  HANDLE pronto_;
  HRESULT hr_ = E_FAIL;
  ComPtr<IAudioClient> cliente_;
};

struct Sessao {
  std::atomic<bool> rodando{false};
  std::thread thread;
  Napi::ThreadSafeFunction dados;
  Napi::ThreadSafeFunction erro;
  DWORD pid = 0;
  bool excluir = false;
};

void AvisaErro(Sessao* s, const std::string& msg) {
  if (!s->erro) return;
  std::string* copia = new std::string(msg);
  s->erro.BlockingCall(copia, [](Napi::Env env, Napi::Function cb, std::string* m) {
    cb.Call({Napi::String::New(env, *m)});
    delete m;
  });
}

void Capturar(Sessao* s) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool comInit = SUCCEEDED(hr);

  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = s->pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      s->excluir ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                 : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT pv{};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  ComPtr<Handler> handler = Make<Handler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                   __uuidof(IAudioClient), &pv, handler.Get(), &op);
  if (FAILED(hr)) {
    AvisaErro(s, HrTexto("ActivateAudioInterfaceAsync", hr));
    if (comInit) CoUninitialize();
    return;
  }
  if (WaitForSingleObject(handler->pronto_, 4000) != WAIT_OBJECT_0 || FAILED(handler->hr_)) {
    AvisaErro(s, HrTexto("ativação do process loopback", handler->hr_));
    if (comInit) CoUninitialize();
    return;
  }
  ComPtr<IAudioClient> cliente = handler->cliente_;

  // No process loopback não existe GetMixFormat: o formato é escolhido aqui e o
  // Windows converte o que os apps tocam.
  WAVEFORMATEX wf{};
  wf.wFormatTag = WAVE_FORMAT_PCM;
  wf.nChannels = kCanais;
  wf.nSamplesPerSec = kTaxa;
  wf.wBitsPerSample = kBits;
  wf.nBlockAlign = wf.nChannels * wf.wBitsPerSample / 8;
  wf.nAvgBytesPerSec = wf.nSamplesPerSec * wf.nBlockAlign;

  hr = cliente->Initialize(AUDCLNT_SHAREMODE_SHARED,
                           AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                           200000 /* 20 ms */, 0, &wf, nullptr);
  if (FAILED(hr)) {
    AvisaErro(s, HrTexto("IAudioClient::Initialize", hr));
    if (comInit) CoUninitialize();
    return;
  }

  HANDLE evento = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = cliente->SetEventHandle(evento);
  ComPtr<IAudioCaptureClient> captura;
  if (SUCCEEDED(hr)) hr = cliente->GetService(IID_PPV_ARGS(&captura));
  if (SUCCEEDED(hr)) hr = cliente->Start();
  if (FAILED(hr)) {
    AvisaErro(s, HrTexto("início da captura", hr));
    CloseHandle(evento);
    if (comInit) CoUninitialize();
    return;
  }

  while (s->rodando.load()) {
    // 200 ms de espera: sem áudio nenhum tocando o evento não vem, e o laço
    // ainda precisa acordar pra ver se mandaram parar
    WaitForSingleObject(evento, 200);
    for (;;) {
      BYTE* dados = nullptr;
      UINT32 quadros = 0;
      DWORD flags = 0;
      hr = captura->GetBuffer(&dados, &quadros, &flags, nullptr, nullptr);
      if (hr == AUDCLNT_S_BUFFER_EMPTY || FAILED(hr) || quadros == 0) break;

      const size_t bytes = static_cast<size_t>(quadros) * wf.nBlockAlign;
      auto* bloco = new std::string();
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        bloco->assign(bytes, '\0');            // silêncio vem sem dados válidos
      } else {
        bloco->assign(reinterpret_cast<char*>(dados), bytes);
      }
      captura->ReleaseBuffer(quadros);

      if (s->dados) {
        s->dados.BlockingCall(bloco, [](Napi::Env env, Napi::Function cb, std::string* b) {
          cb.Call({Napi::Buffer<char>::Copy(env, b->data(), b->size())});
          delete b;
        });
      } else {
        delete bloco;
      }
    }
  }

  cliente->Stop();
  CloseHandle(evento);
  if (comInit) CoUninitialize();
}

// start({ pid, modo: 'incluir'|'excluir', onData(buffer), onError(msg) }) -> handle
Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "esperava um objeto de opções").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object opt = info[0].As<Napi::Object>();
  if (!opt.Has("pid") || !opt.Has("onData")) {
    Napi::TypeError::New(env, "faltou pid ou onData").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto* s = new Sessao();
  s->pid = static_cast<DWORD>(opt.Get("pid").As<Napi::Number>().Uint32Value());
  s->excluir = opt.Has("modo") && opt.Get("modo").As<Napi::String>().Utf8Value() == "excluir";
  s->dados = Napi::ThreadSafeFunction::New(env, opt.Get("onData").As<Napi::Function>(),
                                           "mimo-loopback-dados", 0, 1);
  if (opt.Has("onError")) {
    s->erro = Napi::ThreadSafeFunction::New(env, opt.Get("onError").As<Napi::Function>(),
                                            "mimo-loopback-erro", 0, 1);
  }
  s->rodando.store(true);
  s->thread = std::thread(Capturar, s);

  Napi::Object handle = Napi::Object::New(env);
  handle.Set("pid", Napi::Number::New(env, s->pid));
  handle.Set("stop", Napi::Function::New(env, [s](const Napi::CallbackInfo& i) {
    if (s->rodando.exchange(false)) {
      if (s->thread.joinable()) s->thread.join();
      if (s->dados) s->dados.Release();
      if (s->erro) s->erro.Release();
    }
    return i.Env().Undefined();
  }));
  return handle;
}

// O modo EXCLUDE só existe a partir do build 20348; abaixo disso nem adianta
Napi::Value Suportado(const Napi::CallbackInfo& info) {
  OSVERSIONINFOEXW v{};
  v.dwOSVersionInfoSize = sizeof(v);
  v.dwBuildNumber = 20348;
  DWORDLONG cond = 0;
  VER_SET_CONDITION(cond, VER_BUILDNUMBER, VER_GREATER_EQUAL);
  const bool ok = VerifyVersionInfoW(&v, VER_BUILDNUMBER, cond) != FALSE;
  return Napi::Boolean::New(info.Env(), ok);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("suportado", Napi::Function::New(env, Suportado));
  exports.Set("formato", [&] {
    Napi::Object f = Napi::Object::New(env);
    f.Set("taxa", Napi::Number::New(env, kTaxa));
    f.Set("canais", Napi::Number::New(env, kCanais));
    f.Set("bits", Napi::Number::New(env, kBits));
    return f;
  }());
  return exports;
}

}  // namespace

NODE_API_MODULE(mimo_loopback, Init)
