// https://github.com/padenot/ringbuf.js
// customised for Glicol

let exports = {}

Object.defineProperty(exports, '__esModule', { value: true });

// customised for Glicol
// TextParameter has a varied length
class TextParameterWriter {
  // From a RingBuffer, build an object that can enqueue a parameter change in
  // the queue.
  constructor(ringbuf) {
    if (ringbuf.type() != "Uint8Array") {
      throw "This class requires a ring buffer of Uint8Array";
    }
    // const SIZE_ELEMENT = 5;
    this.ringbuf = ringbuf
  }
  // Returns the number of samples that have been successfuly written to the
  // queue. `buf` is not written to during this call, so the samples that
  // haven't been written to the queue are still available.
  enqueue(buf) {
    return this.ringbuf.push(buf);
  }
  // Query the free space in the ring buffer. This is the amount of samples that
  // can be queued, with a guarantee of success.
  available_write() {
    return this.ringbuf.available_write();
  }
}

class TextParameterReader {
  constructor(ringbuf) {
    if (ringbuf.type() != "Uint8Array") {
      throw "This class requires a ring buffer of Uint8Array";
    }
    this.ringbuf = ringbuf;
  }
  // Attempt to dequeue at most `buf.length` samples from the queue. This
  // returns the number of samples dequeued. If greater than 0, the samples are
  // at the beginning of `buf`
  dequeue(buf) {
    if (this.ringbuf.empty()) {
      return 0;
    }
    return this.ringbuf.pop(buf);
  }
  // Query the occupied space in the queue. This is the amount of samples that
  // can be read with a guarantee of success.
  available_read() {
    return this.ringbuf.available_read();
  }
}

// A Single Producer - Single Consumer thread-safe wait-free ring buffer.
//
// The producer and the consumer can be separate thread, but cannot change role,
// except with external synchronization.

class RingBuffer {
  static getStorageForCapacity(capacity, type) {
    if (!type.BYTES_PER_ELEMENT) {
      throw "Pass in a ArrayBuffer subclass";
    }
    var bytes = 8 + (capacity + 1) * type.BYTES_PER_ELEMENT;
    return new SharedArrayBuffer(bytes);
  }
  // `sab` is a SharedArrayBuffer with a capacity calculated by calling
  // `getStorageForCapacity` with the desired capacity.
  constructor(sab, type) {
    if (!ArrayBuffer.__proto__.isPrototypeOf(type) &&
      type.BYTES_PER_ELEMENT !== undefined) {
      throw "Pass a concrete typed array class as second argument";
    }

    // Maximum usable size is 1<<32 - type.BYTES_PER_ELEMENT bytes in the ring
    // buffer for this version, easily changeable.
    // -4 for the write ptr (uint32_t offsets)
    // -4 for the read ptr (uint32_t offsets)
    // capacity counts the empty slot to distinguish between full and empty.
    this._type = type;
    this.capacity = (sab.byteLength - 8) / type.BYTES_PER_ELEMENT;
    this.buf = sab;
    this.write_ptr = new Uint32Array(this.buf, 0, 1);
    this.read_ptr = new Uint32Array(this.buf, 4, 1);
    this.storage = new type(this.buf, 8, this.capacity);
  }
  // Returns the type of the underlying ArrayBuffer for this RingBuffer. This
  // allows implementing crude type checking.
  type() {
    return this._type.name;
  }
  // Push bytes to the ring buffer. `bytes` is an typed array of the same type
  // as passed in the ctor, to be written to the queue.
  // Returns the number of elements written to the queue.
  push(elements) {
    var rd = Atomics.load(this.read_ptr, 0);
    var wr = Atomics.load(this.write_ptr, 0);

    if ((wr + 1) % this._storage_capacity() == rd) {
      // full
      return 0;
    }

    let to_write = Math.min(this._available_write(rd, wr), elements.length);
    let first_part = Math.min(this._storage_capacity() - wr, to_write);
    let second_part = to_write - first_part;

    this._copy(elements, 0, this.storage, wr, first_part);
    this._copy(elements, first_part, this.storage, 0, second_part);

    // publish the enqueued data to the other side
    Atomics.store(
      this.write_ptr,
      0,
      (wr + to_write) % this._storage_capacity()
    );

    return to_write;
  }
  // Read `elements.length` elements from the ring buffer. `elements` is a typed
  // array of the same type as passed in the ctor.
  // Returns the number of elements read from the queue, they are placed at the
  // beginning of the array passed as parameter.
  pop(elements) {
    var rd = Atomics.load(this.read_ptr, 0);
    var wr = Atomics.load(this.write_ptr, 0);

    if (wr == rd) {
      return 0;
    }

    let to_read = Math.min(this._available_read(rd, wr), elements.length);

    let first_part = Math.min(this._storage_capacity() - rd, elements.length);
    let second_part = to_read - first_part;

    this._copy(this.storage, rd, elements, 0, first_part);
    this._copy(this.storage, 0, elements, first_part, second_part);

    Atomics.store(this.read_ptr, 0, (rd + to_read) % this._storage_capacity());

    return to_read;
  }

  // True if the ring buffer is empty false otherwise. This can be late on the
  // reader side: it can return true even if something has just been pushed.
  empty() {
    var rd = Atomics.load(this.read_ptr, 0);
    var wr = Atomics.load(this.write_ptr, 0);

    return wr == rd;
  }

  // True if the ring buffer is full, false otherwise. This can be late on the
  // write side: it can return true when something has just been poped.
  full() {
    var rd = Atomics.load(this.read_ptr, 0);
    var wr = Atomics.load(this.write_ptr, 0);

    return (wr + 1) % this.capacity != rd;
  }

  // The usable capacity for the ring buffer: the number of elements that can be
  // stored.
  capacity() {
    return this.capacity - 1;
  }

  // Number of elements available for reading. This can be late, and report less
  // elements that is actually in the queue, when something has just been
  // enqueued.
  available_read() {
    var rd = Atomics.load(this.read_ptr, 0);
    var wr = Atomics.load(this.write_ptr, 0);
    return this._available_read(rd, wr);
  }

  // Number of elements available for writing. This can be late, and report less
  // elemtns that is actually available for writing, when something has just
  // been dequeued.
  available_write() {
    var rd = Atomics.load(this.read_ptr, 0);
    var wr = Atomics.load(this.write_ptr, 0);
    return this._available_write(rd, wr);
  }

  // private methods //

  // Number of elements available for reading, given a read and write pointer..
  _available_read(rd, wr) {
    if (wr > rd) {
      return wr - rd;
    } else {
      return wr + this._storage_capacity() - rd;
    }
  }

  // Number of elements available from writing, given a read and write pointer.
  _available_write(rd, wr) {
    let rv = rd - wr - 1;
    if (wr >= rd) {
      rv += this._storage_capacity();
    }
    return rv;
  }

  // The size of the storage for elements not accounting the space for the index.
  _storage_capacity() {
    return this.capacity;
  }

  // Copy `size` elements from `input`, starting at offset `offset_input`, to
  // `output`, starting at offset `offset_output`.
  _copy(input, offset_input, output, offset_output, size) {
    for (var i = 0; i < size; i++) {
      output[offset_output + i] = input[offset_input + i];
    }
  }
}

exports.TextParameterReader = TextParameterReader;
exports.TextParameterWriter = TextParameterWriter;
exports.RingBuffer = RingBuffer;

class GlicolEngine extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return []
    }
    constructor() {
        super()
        var sampleLength, samplePtr, sampleArray;
        this.ptrArr = [];
        this.lenArr = [];
        this.nameArr = [];
        this.nameLenArr = [];

        var allocUint32Array = (arr, wasmFunc, wasmBuffer) => {
            let len = arr.length
            let ptr = wasmFunc(len); // actually it's byteoffset
            let tempArr = new Uint32Array(wasmBuffer, ptr, len)
            tempArr.set(arr)
            return {ptr: ptr, len: len}
        }

        this._codeArray = new Uint8Array(4096);
        this._resultArray = new Uint8Array(256);
        this.port.onmessage = async e => {
            if (e.data.type === "load") {
                await WebAssembly.instantiate(e.data.obj, {
                  env: {
                    now: Date.now
                  }
                }).then(obj => {
                  // console.log(obj)
                    this._wasm = obj.instance
                    this._size = 256
                    this._outPtr = this._wasm.exports.alloc(this._size)
                    this._outBuf = new Float32Array(
                      this._wasm.exports.memory.buffer,
                      this._outPtr,
                      this._size
                    )
                    // console.log(Math.random() * 100);
                    this._wasm.exports.set_sr(sampleRate);
                    this._wasm.exports.set_seed(Math.random()*4096);
                })
                this.port.postMessage({type: 'ready'})

            } else if (e.data.type === "samples") {
                console.log('samples')
                if(this._wasm) {
                // console.log("sample data: ", e.data.sample)
                // console.log(e.data.name)

                let s = e.data.sample
                // let s = Float32Array.from(_s, i => i/32768.0)

                sampleLength = s.length;
                samplePtr = this._wasm.exports.alloc(sampleLength);
                sampleArray = new Float32Array(
                    this._wasm.exports.memory.buffer,
                    samplePtr,
                    sampleLength
                );

                this.ptrArr.push(samplePtr)
                this.lenArr.push(sampleLength)

                sampleArray.set(s);
                
                let nameLen = e.data.name.byteLength
                let namePtr = this._wasm.exports.alloc_uint8array(nameLen);
                let name = new Uint8Array(this._wasm.exports.memory.buffer, namePtr, nameLen);
                name.set(e.data.name);
                           
                this.nameArr.push(namePtr)
                this.nameLenArr.push(nameLen)

                // need to reset this
                this._outBuf = new Float32Array(
                    this._wasm.exports.memory.buffer,
                    this._outPtr,
                    this._size
                )
                }
            } else if (e.data.type === "bpm") {
                this._wasm.exports.set_bpm(e.data.value);
            } else if (e.data.type === "amp") {
                this._wasm.exports.set_track_amp(e.data.value);
            } else if (e.data.type === "run") {
                console.log('run')
                
                // the code as Uint8 to parse; e.data.value == the code
                this.code = e.data.value;
                let codeLen = e.data.value.byteLength
                let codeUint8ArrayPtr = this._wasm.exports.alloc_uint8array(codeLen);
                let codeUint8Array = new Uint8Array(this._wasm.exports.memory.buffer, codeUint8ArrayPtr, codeLen);
                codeUint8Array.set(e.data.value);

                let sampleInfoLen = this.ptrArr.length
                let sampleInfoPtr = this._wasm.exports.alloc_uint32array(sampleInfoLen)
                let sampleInfo = new Uint32Array(this._wasm.exports.memory.buffer, sampleInfoPtr, sampleInfoLen) 
                sampleInfo.set(this.ptrArr)

                let lengthInfoLen = this.lenArr.length
                let lengthInfoPtr = this._wasm.exports.alloc_uint32array(lengthInfoLen)
                let lengthInfo = new Uint32Array(this._wasm.exports.memory.buffer, lengthInfoPtr, lengthInfoLen) 
                lengthInfo.set(this.lenArr)

                let nameInfoLen = this.nameArr.length
                let nameInfoPtr = this._wasm.exports.alloc_uint32array(nameInfoLen)
                let nameInfo = new Uint32Array(this._wasm.exports.memory.buffer, nameInfoPtr, nameInfoLen) 
                nameInfo.set(this.nameArr)

                let nameLenInfoLen = this.nameArr.length
                let nameLenInfoPtr = this._wasm.exports.alloc_uint32array(nameLenInfoLen)
                let nameLenInfo = new Uint32Array(this._wasm.exports.memory.buffer, nameLenInfoPtr, nameLenInfoLen) 
                nameLenInfo.set(this.nameLenArr)

                this._wasm.exports.run(
                  codeUint8ArrayPtr, codeLen,
                  sampleInfoPtr, sampleInfoLen,
                  lengthInfoPtr, lengthInfoLen,
                  nameInfoPtr, nameInfoLen,
                  nameLenInfoPtr, nameLenInfoLen
                )

            } else if (e.data.type === "update") {

                // the code as Uint8 to parse
                let codeLen = e.data.value.byteLength
                let codeUint8ArrayPtr = this._wasm.exports.alloc_uint8array(codeLen);
                let codeUint8Array = new Uint8Array(this._wasm.exports.memory.buffer, codeUint8ArrayPtr, codeLen);
                codeUint8Array.set(e.data.value);

                // for updating, no need to pass in samples
                this._wasm.exports.update(codeUint8ArrayPtr, codeLen)
            } else if (e.data.type === "sab") {
                this._param_reader = new TextParameterReader(new RingBuffer(e.data.data, Uint8Array));
            }  else if (e.data.type === "result") {
                this._result_reader = new TextParameterReader(new RingBuffer(e.data.data, Uint8Array));
            } else {
                throw "unexpected.";
            }
        }
    }

    process(inputs, outputs, _parameters) {
        if(!this._wasm) {
            return true
        }

        let size = this._param_reader.dequeue(this._codeArray)
        if (size) {
            let codeUint8ArrayPtr = this._wasm.exports.alloc_uint8array(size);
            let codeUint8Array = new Uint8Array(this._wasm.exports.memory.buffer, codeUint8ArrayPtr, size);
            codeUint8Array.set(this._codeArray.slice(0, size));

            // for updating, no need to pass in samples
            this._wasm.exports.update(codeUint8ArrayPtr, size)
        }

      //   if (midiSize) {
      //     let codeUint8ArrayPtr = this._wasm.exports.alloc_uint8array(size);
      //     let codeUint8Array = new Uint8Array(this._wasm.exports.memory.buffer, codeUint8ArrayPtr, size);
      //     codeUint8Array.set(this._codeArray.slice(0, size));

      //     // for updating, no need to pass in samples
    //     this._wasm.exports.update(codeUint8ArrayPtr, size)
      // }

        if (inputs[0][0]) {
            this._inPtr = this._wasm.exports.alloc(128)
            this._inBuf = new Float32Array(
                this._wasm.exports.memory.buffer,
                this._inPtr,
                128
            )
            this._inBuf.set(inputs[0][0])
        }

        let resultPtr = this._wasm.exports.process(
          this._inPtr, this._outPtr, this._size)

        this._outBuf = new Float32Array(
            this._wasm.exports.memory.buffer,
            this._outPtr,
            this._size
        )
    
        let result = new Uint8Array(
            this._wasm.exports.memory.buffer,
            resultPtr,
            256
        )

        if (result[0] !== 0) {
            this.port.postMessage({type: 'e', info: result.slice(0,256)})
        }

        outputs[0][0].set(this._outBuf.slice(0, 128))
        outputs[0][1].set(this._outBuf.slice(128, 256))
        return true
    }
}

registerProcessor('glicol-engine', GlicolEngine)